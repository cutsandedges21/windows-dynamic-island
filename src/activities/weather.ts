// Weather: current conditions and a heads-up when rain is coming, from
// Open-Meteo (free, no key). Network trouble is quiet: the last reading stays
// until it is a few hours old.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { native } from '../core/native';
import type { Seg, Tone } from '../core/segments';
import type { Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Options = { city: string; units: string };
type Geo = { city: string; lat: number; lon: number; place: string };
/** One of the hours after the current one: `hour` is 0 to 23 on the city's own clock. */
type Hour = { hour: number; temp: number; code: number; day: boolean };
type Reading = { temp: number; code: number; day: boolean; rain: number; at: number; hi: number | null; lo: number | null; hours: Hour[] };
type Forecast = {
  current?: { time?: string; temperature_2m?: number; weather_code?: number; is_day?: number };
  hourly?: {
    time?: string[];
    precipitation_probability?: Array<number | null>;
    temperature_2m?: Array<number | null>;
    weather_code?: Array<number | null>;
    is_day?: Array<number | null>;
  };
  daily?: { temperature_2m_max?: Array<number | null>; temperature_2m_min?: Array<number | null> };
};
type Geocoded = { results?: Array<{ latitude?: number; longitude?: number; name?: string }> };

const REFRESH_MS = 15 * 60000;
const RETRY_MS = 60000;
/** An old reading is worse than none. */
const STALE_MS = 3 * 3600000;
const RAIN_EVERY_MS = 3600000;
const RAIN_SHOW_MS = 5000;
const RAIN_AT = 60;
/** The tile's hourly strip: the next four hours. */
const HOURS_SHOWN = 4;
/** An hourly strip older than this has slid out of date (a retry after a failed refresh); leave it off. */
const HOURS_FRESH_MS = 30 * 60000;

/** WMO weather codes to an icon that exists and a short word. */
function describe(code: number, day: boolean): { icon: string; word: string; tone?: Tone } {
  if (code === 0) return day ? { icon: 'sun', word: 'Clear', tone: 'warn' } : { icon: 'moon', word: 'Clear', tone: 'violet' };
  if (code <= 2) return { icon: 'cloud-sun', word: code === 1 ? 'Mostly clear' : 'Partly cloudy' };
  if (code === 3) return { icon: 'cloud', word: 'Cloudy' };
  if (code === 45 || code === 48) return { icon: 'fog', word: 'Fog' };
  if (code >= 51 && code <= 57) return { icon: 'rain', word: 'Drizzle', tone: 'info' };
  if (code >= 61 && code <= 67) return { icon: 'rain', word: 'Rain', tone: 'info' };
  if (code >= 71 && code <= 77) return { icon: 'snow', word: 'Snow', tone: 'info' };
  if (code >= 80 && code <= 82) return { icon: 'rain', word: 'Showers', tone: 'info' };
  if (code === 85 || code === 86) return { icon: 'snow', word: 'Snow showers', tone: 'info' };
  if (code >= 95 && code <= 99) return { icon: 'storm', word: 'Storm', tone: 'warn' };
  return { icon: 'cloud', word: 'Cloudy' };
}

/** Already raining, snowing or storming: no point warning about it. */
const wet = (code: number) => (code >= 51 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || code >= 95;

/** "4 PM": the hour of the city's own clock, whatever the machine's locale. */
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

/**
 * The hours after the current one. Open-Meteo's hourly list (forecast_hours) starts at the current hour,
 * and with `timezone=auto` its times are the city's local time ("2026-09-30T16:00").
 */
function followingHours(j: Forecast): Hour[] {
  const h = j.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m) || !Array.isArray(h.weather_code)) return [];
  const current = j.current?.time?.slice(0, 13);
  const out: Hour[] = [];
  for (let i = 0; i < h.time.length && out.length < HOURS_SHOWN; i++) {
    const at = h.time[i];
    const temp = h.temperature_2m[i];
    const code = h.weather_code[i];
    if (typeof at !== 'string' || typeof temp !== 'number' || typeof code !== 'number') continue;
    if (current ? at.slice(0, 13) <= current : i === 0) continue;
    const hour = Number(at.slice(11, 13));
    if (Number.isInteger(hour)) out.push({ hour, temp, code, day: h.is_day?.[i] !== 0 });
  }
  return out;
}

function json<T>(r: { status: number; body: string } | null): T | null {
  if (!r || r.status !== 200) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}

export class WeatherActivity extends BaseActivity {
  private geo: Geo | null = null;
  private wx: Reading | null = null;
  private key = '';
  private lastTry = 0;
  private failed = false;
  private busy = false;
  private rainAt = 0;

  constructor() {
    super('weather');
  }

  protected init(): void {
    // A 1 minute clock; refresh() decides whether a fetch is due (15 minutes, or 1 minute after a failure).
    this.every(60000, () => void this.refresh(), true);
  }

  reconfigure(): void {
    void this.refresh();
  }

  private opts(): { city: string; fahrenheit: boolean } {
    const o = this.ctx.options<Partial<Options>>();
    return { city: typeof o.city === 'string' ? o.city.trim() : '', fahrenheit: o.units === 'fahrenheit' };
  }

  private async refresh(): Promise<void> {
    const { city, fahrenheit } = this.opts();
    const key = `${city.toLowerCase()}|${fahrenheit}`;
    if (key !== this.key) {
      this.key = key;
      this.geo = null;
      this.wx = null;
      this.lastTry = 0;
      this.failed = false;
      this.ctx.update();
    }
    if (!city || this.busy) return;
    const now = Date.now();
    if (now - this.lastTry < (this.failed ? RETRY_MS : REFRESH_MS) - 1000) return;

    this.busy = true;
    this.lastTry = now;
    try {
      const ok = await this.load(city, fahrenheit, key);
      if (key === this.key) this.failed = !ok;
    } finally {
      this.busy = false;
    }
    if (this.alive && key !== this.key) void this.refresh(); // the city changed while this was loading
    this.ctx.update();
  }

  private async load(city: string, fahrenheit: boolean, key: string): Promise<boolean> {
    if (!this.geo || this.geo.city !== city) {
      const hit = json<Geocoded>(await native.httpGet(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`))?.results?.[0];
      if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return false;
      if (!this.alive || key !== this.key) return false;
      this.geo = { city, lat: hit.latitude, lon: hit.longitude, place: hit.name || city };
    }
    const { lat, lon } = this.geo;
    // One request for everything: now, the next hours (rain chance for the heads-up, temperature and sky for the tile) and today's range.
    // The daily range needs a timezone; `auto` is the city's own, which also makes the hourly times its local clock.
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day` +
      `&hourly=precipitation_probability,temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min` +
      `&forecast_days=1&forecast_hours=${HOURS_SHOWN + 1}&timezone=auto${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`;
    const j = json<Forecast>(await native.httpGet(url));
    const c = j?.current;
    if (!j || !c || typeof c.temperature_2m !== 'number' || typeof c.weather_code !== 'number') return false;
    if (!this.alive || key !== this.key) return false;

    // The next hour or so: this hour's and the following hour's chance of rain.
    const chances = (j.hourly?.precipitation_probability ?? []).slice(0, 2).filter((n): n is number => typeof n === 'number');
    const hi = j.daily?.temperature_2m_max?.[0];
    const lo = j.daily?.temperature_2m_min?.[0];
    this.wx = {
      temp: c.temperature_2m,
      code: c.weather_code,
      day: c.is_day !== 0,
      rain: chances.length ? Math.max(...chances) : 0,
      at: Date.now(),
      hi: typeof hi === 'number' ? hi : null,
      lo: typeof lo === 'number' ? lo : null,
      hours: followingHours(j),
    };
    if (this.wx.rain >= RAIN_AT && !wet(this.wx.code) && Date.now() - this.rainAt >= RAIN_EVERY_MS) {
      this.rainAt = Date.now();
      this.ctx.surface({ key: 'rain', ms: RAIN_SHOW_MS, level: 'expanded' });
      this.saw('rain', 'weather:rain');
    }
    return true;
  }

  private fresh(): Reading | null {
    return this.wx && Date.now() - this.wx.at < STALE_MS ? this.wx : null;
  }

  status(): ActivityStatus {
    const w = this.fresh();
    if (!w || !this.opts().city) return { active: false };
    return { active: true, weight: 'background', summary: `${Math.round(w.temp)}° ${describe(w.code, w.day).word}` };
  }

  chip(): ChipView | null {
    const w = this.fresh();
    if (!w) return null;
    const d = describe(w.code, w.day);
    return { icon: d.icon, label: `${Math.round(w.temp)}°`, tone: d.tone };
  }

  /** Nothing until the first reading arrives. */
  tile(env: SheetEnv): Tile | null {
    const w = this.fresh();
    if (!w || !this.geo) return null;
    const d = describe(w.code, w.day);
    const range = w.hi !== null && w.lo !== null ? ` · H ${Math.round(w.hi)}° L ${Math.round(w.lo)}°` : '';
    const hours = env.now - w.at < HOURS_FRESH_MS ? w.hours : [];
    return {
      key: 'weather',
      span: 2,
      tone: d.tone,
      body: {
        k: 'forecast',
        icon: d.icon,
        temp: `${Math.round(w.temp)}°`,
        label: `${d.word}${range}`,
        hours: hours.map((x) => ({ t: hourLabel(x.hour), icon: describe(x.code, x.day).icon, temp: `${Math.round(x.temp)}°` })),
      },
    };
  }

  render(env: RenderEnv): Seg[] {
    const w = this.fresh();
    if (!w || !this.geo) return [];
    const { fahrenheit } = this.opts();
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const temp = `${Math.round(w.temp)}°${env.level === 'maximum' && !env.vertical ? (fahrenheit ? 'F' : 'C') : ''}`;

    if (this.rainAt && env.now - this.rainAt < RAIN_SHOW_MS && w.rain >= RAIN_AT && !wet(w.code)) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'rain', tone: 'info', prio: 0 },
        { t: 'text', key: 'main', text: env.vertical ? `${w.rain}%` : 'Rain soon', weight: 'semibold', prio: 0 },
      ];
      if (roomy && !env.vertical) {
        segs.push(
          { t: 'text', key: 'chance', text: `${w.rain}% chance`, tone: 'muted', prio: 3 },
          { t: 'text', key: 'temp', text: temp, side: 'end', prio: 2 },
        );
      }
      return segs;
    }

    const d = describe(w.code, w.day);
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: d.icon, tone: d.tone, prio: 0 },
      { t: 'text', key: 'temp', text: temp, weight: 'semibold', prio: 0 },
    ];
    if (roomy && !env.vertical) {
      segs.push(
        { t: 'text', key: 'word', text: d.word, tone: 'muted', prio: 3 },
        { t: 'text', key: 'place', text: this.geo.place, tone: 'muted', size: 'sm', side: 'end', prio: 5 },
      );
    }
    return segs;
  }
}
