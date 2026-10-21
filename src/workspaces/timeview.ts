// The Workspaces page's Time tab: where the week went, workspace by workspace, as Notice what I
// work on counted it. A bar a day, stacked by workspace, with the average day as a dashed line;
// a donut of the week (or of the day picked in the bars) with each workspace's time and share.
// The numbers come from time.ts; the island hands over the spans (page.ts asks).

import { icon } from '../core/icons';
import { h } from '../dom';
import type { Ctx } from './ctx';
import { averageDay, DAY_LETTERS, dayName, hm, midnights, seriesMs, seriesOf, shares, shareText, weekLabel, weekOf, weekStart, type Series, type Week } from './time';
import { iconButton } from './ui';

const SVG = 'http://www.w3.org/2000/svg';
/** The numbers on screen are fetched again once they're this old. */
const STALE_MS = 60_000;

/** Fetches the shown week when it's missing or a minute old (or `force`), and redraws when it comes. */
export function loadTime(ctx: Ctx, force = false): void {
  const t = ctx.ui.time;
  const start = weekStart(Date.now(), t.back);
  if (t.loading || (!force && t.spans && t.for === start && Date.now() - t.at < STALE_MS)) return;
  t.loading = true;
  const b = midnights(start);
  ctx.spans(b[0], b[7]).then(
    (spans) => {
      t.loading = false;
      t.spans = spans;
      t.for = start;
      t.at = Date.now();
      ctx.paint();
    },
    () => {
      t.loading = false;
    },
  );
}

/** The accent as a colour (the page is given it as a CSS variable). */
function accentHex(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

const longDay = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

export function timeView(ctx: Ctx): HTMLElement {
  const t = ctx.ui.time;
  const now = Date.now();
  const start = weekStart(now, t.back);
  loadTime(ctx);
  const ready = t.spans !== null && t.for === start;
  // Deleted workspaces' time is left out everywhere, the average too.
  const known = new Set(ctx.store.list.map((w) => w.id));
  const week = weekOf(ready ? t.spans!.filter((s) => known.has(s[2])) : [], start);
  const series = seriesOf(week, ctx.store.list, accentHex());
  if (t.day !== null && week.bounds[t.day] > now) t.day = null;
  const el = h('div', { class: `ws-time${ready ? '' : ' waiting'}${ready && t.fresh ? ' fresh' : ''}` });
  if (ready) t.fresh = false;
  if (!ctx.noticing.on()) el.append(offBanner(ctx));
  el.append(
    weekRow(ctx, start, now),
    h('div', { class: 'ws-time-grid' }, [barsCard(ctx, week, series, now), shareCard(ctx, week, series, now)]),
    h('p', { class: 'ws-time-note', text: `Counted while a workspace’s window is in front and you’re at the keyboard. Kept on this PC for ${ctx.noticing.days()} days.` }),
  );
  return el;
}

function offBanner(ctx: Ctx): HTMLElement {
  const on = h('button', {
    class: 'btn sm primary',
    type: 'button',
    text: 'Turn it on',
    onclick: () => {
      ctx.noticing.turnOn();
      loadTime(ctx, true);
      ctx.paint();
    },
  });
  return h('div', { class: 'ws-banner info', role: 'status', html: icon('info') }, [
    h('p', { text: 'Notice what I work on is off, so Island isn’t counting time in your workspaces. Switched on, it notes which window is in front every few seconds, on this PC only.' }),
    h('div', { class: 'btns' }, [on]),
  ]);
}

/** ‹ This week ›, back as far as Notice keeps. */
function weekRow(ctx: Ctx, start: number, now: number): HTMLElement {
  const t = ctx.ui.time;
  const move = (by: number) => {
    t.back = Math.max(0, t.back + by);
    t.day = null;
    t.fresh = true;
    ctx.paint();
  };
  const prev = iconButton('chevron-left', 'The week before', () => move(1));
  prev.dataset.focus = 'week-prev';
  prev.disabled = start <= weekStart(now - ctx.noticing.days() * 86_400_000);
  const next = iconButton('chevron-right', 'The week after', () => move(-1));
  next.dataset.focus = 'week-next';
  next.disabled = t.back === 0;
  return h('div', { class: 'ws-time-head' }, [prev, h('span', { class: 'ws-time-week', 'aria-live': 'polite', text: weekLabel(start, now) }), next]);
}

// ------------------------------------------------------------------ the bars

function barsCard(ctx: Ctx, week: Week, series: Series[], now: number): HTMLElement {
  const t = ctx.ui.time;
  const totals = week.days.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
  const avg = averageDay(week, now);
  // Headroom over the tallest bar (or the average line) for the line's label.
  const scale = Math.max(avg, ...totals) * 1.12 || 1;
  const card = h('section', { class: 'ws-viz-card ws-bars-card' }, [h('h3', { class: 'ws-viz-title', text: 'Time per day' })]);
  const tip = h('div', { class: 'ws-tip', role: 'tooltip', hidden: true });
  const plot = h('div', { class: 'ws-bars' });
  if (avg > 0) plot.append(h('div', { class: 'ws-avg', style: `--f:${avg / scale}`, 'aria-hidden': 'true' }, [h('span', { text: `avg ${hm(avg)}` })]));
  for (let i = 0; i < 7; i++) {
    const begun = week.bounds[i] <= now;
    const today = begun && now < week.bounds[i + 1];
    const picked = t.day === i;
    const total = totals[i];
    // Largest first, top down, as in the legend.
    const parts = series.map((s) => [s, seriesMs(week.days[i], s)] as const).filter(([, ms]) => ms > 0);
    const stack = total
      ? h('span', { class: 'ws-stack', style: `height:${(total / scale) * 100}%;--i:${i}` }, parts.map(([s, ms]) => h('span', { class: 'ws-seg', style: `background:${s.color};flex-grow:${ms / total}` })))
      : null;
    const cls = ['ws-day', today && 'today', !begun && 'later', picked && 'picked', t.day !== null && !picked && 'dim'].filter(Boolean).join(' ');
    const said = total ? `${hm(total)}${parts.length > 1 ? `: ${parts.map(([s, ms]) => `${s.name} ${hm(ms)}`).join(', ')}` : parts.length ? ` in ${parts[0][0].name}` : ''}` : 'nothing';
    const day = h('button', { class: cls, type: 'button', 'aria-label': `${longDay(week.bounds[i])}, ${said}`, 'aria-pressed': String(picked), 'data-focus': `day:${i}`, disabled: !begun }, [
      h('span', { class: 'ws-col' }, [stack ?? (begun ? h('i', { class: 'ws-zero', 'aria-hidden': 'true' }) : null)]),
      h('span', { class: 'ws-letter', text: DAY_LETTERS[i], 'aria-hidden': 'true' }),
    ]);
    day.addEventListener('click', () => {
      t.day = picked ? null : i;
      ctx.paint();
    });
    if (stack) {
      const show = () => {
        tip.replaceChildren(
          h('div', { class: 'ws-tip-head' }, [h('b', { text: longDay(week.bounds[i]) }), h('span', { text: hm(total) })]),
          ...parts.map(([s, ms]) => h('div', { class: 'ws-tip-row' }, [h('i', { style: `background:${s.color}` }), h('span', { text: s.name }), h('span', { class: 'n', text: hm(ms) })])),
        );
        tip.hidden = false;
        // Above the bar; with no room there, beside it. Always inside the card.
        const c = card.getBoundingClientRect();
        const b = stack.getBoundingClientRect();
        const w = tip.offsetWidth;
        const ht = tip.offsetHeight;
        let left = b.left + b.width / 2 - c.left - w / 2;
        let top = b.top - c.top - ht - 8;
        if (top < 8) {
          const right = b.right - c.left + 10;
          left = right + w <= c.width - 8 ? right : b.left - c.left - w - 10;
          top = b.top - c.top;
        }
        tip.style.left = `${Math.min(Math.max(left, 8), c.width - w - 8)}px`;
        tip.style.top = `${Math.min(Math.max(top, 8), c.height - ht - 8)}px`;
      };
      const hide = () => (tip.hidden = true);
      day.addEventListener('pointerenter', show);
      // Keyboard focus shows what hovering does (not the focus a click leaves behind).
      day.addEventListener('focus', () => day.matches(':focus-visible') && show());
      day.addEventListener('pointerleave', hide);
      day.addEventListener('blur', hide);
    }
    plot.append(day);
  }
  card.append(plot, tip);
  return card;
}

// ------------------------------------------------------------------ the donut

function shareCard(ctx: Ctx, week: Week, series: Series[], now: number): HTMLElement {
  const t = ctx.ui.time;
  const day = t.day;
  const rows = series.map((s) => [s, day === null ? s.ms : seriesMs(week.days[day], s)] as const).filter(([, ms]) => ms > 0);
  const total = rows.reduce((a, [, ms]) => a + ms, 0);
  const pct = shares(rows.map(([, ms]) => ms));
  const scope = day === null ? weekLabel(week.start, now) : dayName(week.bounds[day], now);
  const ring = donut(rows.map(([s, ms]) => ({ key: s.key, color: s.color, ms })), total);
  const card = h('section', { class: 'ws-viz-card ws-share-card' }, [
    h('h3', { class: 'ws-viz-title', text: `Time by workspace · ${scope}` }),
    h('div', { class: 'ws-donut' }, [ring, h('div', { class: 'ws-donut-total' }, [h('b', { text: hm(total) })])]),
  ]);
  if (!rows.length) {
    const when = day !== null ? `on ${dayName(week.bounds[day], now).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase())}` : t.back ? 'that week' : 'yet this week';
    card.append(h('p', { class: 'ws-legend-none', text: `No time in a workspace ${when}.` }));
    return card;
  }
  // A row and its slice light up together.
  const hot = (key: string | null) => {
    ring.classList.toggle('hot', key !== null);
    for (const c of ring.querySelectorAll<SVGElement>('[data-key]')) c.classList.toggle('on', c.dataset.key === key);
    for (const r of card.querySelectorAll<HTMLElement>('.ws-legend-row')) r.classList.toggle('on', r.dataset.key === key);
  };
  for (const c of ring.querySelectorAll<SVGElement>('[data-key]')) {
    c.addEventListener('pointerenter', () => hot(c.dataset.key ?? null));
    c.addEventListener('pointerleave', () => hot(null));
  }
  const legend = h(
    'div',
    { class: 'ws-legend' },
    rows.map(([s, ms], i) => {
      const kids = [
        h('i', { class: 'ws-legend-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'ws-legend-name', text: s.name }),
        h('span', { class: 'ws-legend-time', text: hm(ms) }),
        h('span', { class: 'ws-legend-share', text: shareText(pct[i], ms) }),
      ];
      const row =
        s.key === 'other'
          ? h('div', { class: 'ws-legend-row', 'data-key': s.key, style: `--c:${s.color}` }, kids)
          : h('button', { class: 'ws-legend-row', type: 'button', 'data-key': s.key, 'data-focus': `legend:${s.key}`, title: `Open ${s.name}`, style: `--c:${s.color}`, onclick: () => ctx.go({ kind: 'detail', id: s.key }) }, kids);
      row.addEventListener('pointerenter', () => hot(s.key));
      row.addEventListener('pointerleave', () => hot(null));
      row.addEventListener('focus', () => hot(s.key));
      row.addEventListener('blur', () => hot(null));
      return row;
    }),
  );
  card.append(legend);
  return card;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A ring from 12 o'clock, clockwise, a thin gap between slices; empty, a faint track. */
function donut(parts: Array<{ key: string; color: string; ms: number }>, total: number): SVGSVGElement {
  const R = 81;
  const W = 36;
  const C = 2 * Math.PI * R;
  const gap = parts.length > 1 ? 2.4 : 0;
  const ring = svg('svg', { viewBox: '0 0 200 200', class: 'ws-ring', 'aria-hidden': 'true' });
  if (!parts.length) ring.append(svg('circle', { cx: 100, cy: 100, r: R, 'stroke-width': W, class: 'ws-ring-track' }));
  let at = 0;
  for (const p of parts) {
    const len = (p.ms / total) * C;
    // A sliver stays visible.
    const draw = Math.max(1.4, len - gap);
    const slice = svg('circle', { cx: 100, cy: 100, r: R, stroke: p.color, 'stroke-width': W, 'stroke-dasharray': `${draw} ${C - draw}`, 'stroke-dashoffset': -(at + gap / 2), transform: 'rotate(-90 100 100)' });
    slice.dataset.key = p.key;
    ring.append(slice);
    at += len;
  }
  return ring;
}
