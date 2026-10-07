// Built-in activities. The island only sees factories keyed by id; adding an
// activity means one entry here and one in catalog.ts.

import type { Activity } from '../core/activity';
import { AskActivity } from './ask';
import { BatteryActivity } from './battery';
import { CalendarActivity } from './calendar';
import { CallsActivity } from './calls';
import { ClaudeActivity } from './claude';
import { ClipboardActivity } from './clipboard';
import { DevicesActivity } from './devices';
import { DownloadsActivity } from './downloads';
import { ExternalActivity } from './external';
import { GameActivity } from './game';
import { CalcomActivity } from './integrations/calcom';
import { GithubActivity } from './integrations/github';
import { N8nActivity } from './integrations/n8n';
import { NotionActivity } from './integrations/notion';
import { ResendActivity } from './integrations/resend';
import { StripeActivity } from './integrations/stripe';
import { VercelActivity } from './integrations/vercel';
import { LocalActivity } from './local';
import { MusicActivity } from './music';
import { NetworkActivity } from './network';
import { QuickActivity } from './quick';
import { ScreenshotsActivity } from './screenshots';
import { ServersActivity } from './servers';
import { SoundActivity } from './sound';
import { SystemActivity } from './system';
import { TimerActivity } from './timer';
import { WeatherActivity } from './weather';

export function createRegistry(): Map<string, () => Activity> {
  return new Map<string, () => Activity>([
    ['claude', () => new ClaudeActivity()],
    ['music', () => new MusicActivity()],
    ['game', () => new GameActivity()],
    ['timer', () => new TimerActivity()],
    ['downloads', () => new DownloadsActivity()],
    ['battery', () => new BatteryActivity()],
    ['sound', () => new SoundActivity()],
    ['screenshots', () => new ScreenshotsActivity()],
    ['calls', () => new CallsActivity()],
    ['devices', () => new DevicesActivity()],
    ['external', () => new ExternalActivity()],
    ['system', () => new SystemActivity()],
    ['weather', () => new WeatherActivity()],
    ['calendar', () => new CalendarActivity()],
    ['clipboard', () => new ClipboardActivity()],
    ['network', () => new NetworkActivity()],
    ['servers', () => new ServersActivity()],
    ['quick', () => new QuickActivity()],
    ['ask', () => new AskActivity()],
    ['local', () => new LocalActivity()],
    ['github', () => new GithubActivity()],
    ['vercel', () => new VercelActivity()],
    ['n8n', () => new N8nActivity()],
    ['stripe', () => new StripeActivity()],
    ['calcom', () => new CalcomActivity()],
    ['resend', () => new ResendActivity()],
    ['notion', () => new NotionActivity()],
  ]);
}
