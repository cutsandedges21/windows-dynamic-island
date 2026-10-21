// Built-in activities. The island only sees factories keyed by id; adding an
// activity means one entry here and one in catalog.ts.

import type { Activity } from '../core/activity';
import { BatteryActivity } from './battery';
import { LandActivity } from './land';
import { CalendarActivity } from './calendar';
import { CallsActivity } from './calls';
import { ClaudeActivity } from './claude';
import { ClipboardActivity } from './clipboard';
import { DevicesActivity } from './devices';
import { DownloadsActivity } from './downloads';
import { ExternalActivity } from './external';
import { GameActivity } from './game';
import { GithubActivity } from './integrations/github';
import { NotionActivity } from './integrations/notion';
import { VercelActivity } from './integrations/vercel';
import { LocalActivity } from './local';
import { MusicActivity } from './music';
import { NetworkActivity } from './network';
import { PhoneActivity } from './phone';
import { QuickActivity } from './quick';
import { ScreenshotsActivity } from './screenshots';
import { ServersActivity } from './servers';
import { SoundActivity } from './sound';
import { SystemActivity } from './system';
import { TimerActivity } from './timer';
import { WeatherActivity } from './weather';
import { WorkspacesActivity } from './workspaces';

export function createRegistry(): Map<string, () => Activity> {
  return new Map<string, () => Activity>([
    ['claude', () => new ClaudeActivity()],
    ['music', () => new MusicActivity()],
    ['game', () => new GameActivity()],
    ['timer', () => new TimerActivity()],
    ['downloads', () => new DownloadsActivity()],
    ['land', () => new LandActivity()],
    ['battery', () => new BatteryActivity()],
    ['sound', () => new SoundActivity()],
    ['screenshots', () => new ScreenshotsActivity()],
    ['calls', () => new CallsActivity()],
    ['phone', () => new PhoneActivity()],
    ['devices', () => new DevicesActivity()],
    ['external', () => new ExternalActivity()],
    ['system', () => new SystemActivity()],
    ['weather', () => new WeatherActivity()],
    ['calendar', () => new CalendarActivity()],
    ['clipboard', () => new ClipboardActivity()],
    ['network', () => new NetworkActivity()],
    ['workspaces', () => new WorkspacesActivity()],
    ['servers', () => new ServersActivity()],
    ['quick', () => new QuickActivity()],
    ['local', () => new LocalActivity()],
    ['github', () => new GithubActivity()],
    ['vercel', () => new VercelActivity()],
    ['notion', () => new NotionActivity()],
  ]);
}
