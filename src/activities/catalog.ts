// Every built-in activity's identity and defaults: pure data, shared by the
// island (runtime), the Activities page and the settings defaults.

import type { IconName } from '../core/icons';

export type Band = 'high' | 'medium' | 'low';
export type Category = 'developer' | 'media' | 'system' | 'productivity' | 'communication' | 'network';

export interface Behavior {
  /** Expand on its own when something happens. */
  autoShow: boolean;
  /** Stay on the island for as long as it is active (otherwise only on events). */
  persistent: boolean;
  /** Buttons and inputs work directly in the pill. */
  interactive: boolean;
  /** May take over the island from a higher-ranked activity for urgent moments. */
  interrupt: boolean;
}

export type OptionSpec = (
  | { key: string; type: 'toggle'; label: string; help?: string; default: boolean }
  | { key: string; type: 'number'; label: string; help?: string; default: number; min: number; max: number; step?: number; unit?: string }
  | { key: string; type: 'text'; label: string; help?: string; default: string; placeholder?: string; secret?: boolean }
  | { key: string; type: 'choice'; label: string; help?: string; default: string; choices: Array<{ value: string; label: string }> }
  /** Any mix of the choices, at least one (System Stats: CPU, RAM and GPU on the pill). */
  | { key: string; type: 'multi'; label: string; help?: string; default: string[]; choices: Array<{ value: string; label: string }> }
  /**
   * An API key or token. It lives in the Windows Credential Manager under `secret` (such as
   * 'github.token'), never in settings: the Activities page saves it through secretSet, and
   * `default` is always empty.
   */
  | { key: string; type: 'secret'; label: string; help?: string; placeholder?: string; secret: string; default: '' }
) & {
  /** 'never': Windows only, not offered on a Mac (its default must then make sense there too). */
  mac?: 'never';
};

export interface ActivityMeta {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  category: Category;
  enabled: boolean;
  priority: Band;
  behavior: Behavior;
  options: OptionSpec[];
  /** On a Mac: 'soon' = comes in a later part, 'never' = Windows only. Absent = runs on a Mac. */
  mac?: 'soon' | 'never';
  /** Part of Island itself: always on, with no switch to turn it off (Land). */
  builtIn?: boolean;
}

const B = (autoShow: boolean, persistent: boolean, interactive: boolean, interrupt: boolean): Behavior => ({ autoShow, persistent, interactive, interrupt });

export const CATALOG: ActivityMeta[] = [
  {
    id: 'claude',
    mac: 'soon',
    name: 'Claude Code',
    description: 'Shows up when a chat finishes or needs you: permission prompts, questions and replies right in the island, plus your plan limits. Turn on Persistent to keep it on the island all the time.',
    icon: 'claude',
    category: 'developer',
    enabled: true,
    priority: 'high',
    // Not persistent: the island is for everything, so Claude only takes it for its own moments.
    behavior: B(true, false, true, true),
    options: [
      { key: 'resetAlerts', type: 'toggle', label: 'Limit reset alerts', help: 'Tell me when the session or weekly limit resets.', default: true },
      { key: 'sessionHotkeys', type: 'toggle', label: 'Session hotkeys', help: 'Alt+Shift+1–9 switch to a session, Alt+Shift+0 jumps to the one that needs you.', default: true },
      { key: 'notifications', type: 'toggle', label: 'Windows notification', help: 'Also show a toast when a session needs you.', default: true },
      { key: 'phone', type: 'toggle', label: 'Send to my phone', help: 'Finished turns, errors, questions and permission requests go to your phone too, when Settings › Notifications › Send to my phone is on.', default: true },
      { key: 'showLimits', type: 'toggle', label: 'Limits in the island', help: 'Session and weekly limit bars in the expanded island.', default: true },
      { key: 'showDesktop', type: 'toggle', label: 'Claude app chats', help: 'Recent chats from the Claude desktop app, read from its local cache.', default: true },
      { key: 'finishedSeconds', type: 'number', label: 'Show "finished" for', default: 8, min: 3, max: 60, unit: 's' },
      {
        key: 'onlyOtherChats',
        type: 'toggle',
        label: 'Only pop up for other chats',
        help: "When a chat finishes in the window you're in, the island stays small. It opens with Claude's answer only for chats you're not looking at.",
        default: false,
      },
      {
        key: 'replyWindowSeconds',
        type: 'number',
        label: 'Reply window',
        help: 'When a chat finishes while you are elsewhere, it waits this long for a reply typed in the island, so the reply lands in that same chat. Clicking the reply box holds it open. 0 turns it off. Never applies to the chat you are looking at.',
        default: 45,
        min: 0,
        max: 240,
        unit: 's',
      },
      { key: 'requireHello', type: 'toggle', label: 'Windows Hello to Allow', help: 'Ask for your fingerprint, face or PIN before an Allow goes through.', default: false },
    ],
  },
  {
    id: 'music',
    mac: 'soon',
    name: 'Music',
    description: 'Whatever is playing through Windows media controls: Spotify, YouTube, Apple Music and more.',
    icon: 'music',
    category: 'media',
    enabled: true,
    priority: 'low',
    behavior: B(true, true, true, false),
    options: [
      {
        key: 'hoverPlayer',
        type: 'toggle',
        label: 'Player on hover',
        help: "Point at the music on the pill and it grows into a player, like an iPhone's Dynamic Island: the track, a scrubber, and play, skip and sound output. Even when the hover card is set to Claude stats.",
        default: true,
      },
      { key: 'showArt', type: 'toggle', label: 'Album art', default: true },
      { key: 'pausedMinutes', type: 'number', label: 'Keep a paused track for', default: 5, min: 0, max: 120, unit: 'min' },
    ],
  },
  {
    id: 'game',
    mac: 'never',
    name: 'Games',
    description: 'While you play (Steam or another store), the pill shows your frame rate and ping, even at its smallest. Frame rate needs a one-time Windows permission, asked the first time.',
    icon: 'gamepad',
    category: 'media',
    enabled: true,
    priority: 'high',
    behavior: B(true, true, true, false),
    options: [
      { key: 'showPing', type: 'toggle', label: 'Ping', help: "Round trip to the game's server, or to the internet when the server ignores pings.", default: true },
      {
        key: 'overGames',
        type: 'toggle',
        label: 'Show over full-screen games',
        help: 'Keeps the island visible in borderless full-screen games (exclusive full screen hides it anyway). On some PCs an overlay costs a few frames.',
        default: true,
      },
    ],
  },
  {
    id: 'downloads',
    name: 'Downloads',
    description: 'Files arriving in your Downloads folder, with speed and an Open button when done.',
    icon: 'download',
    category: 'system',
    enabled: true,
    priority: 'medium',
    behavior: B(true, true, true, false),
    options: [{ key: 'folder', type: 'text', label: 'Folder', default: '', placeholder: 'Downloads (default)' }],
  },
  {
    id: 'land',
    name: 'Land',
    description:
      "Send files, links and notes to your other computers, friends and phones, like AirDrop. Land is built into Island and always on: it's the little icon on the pill. Click it, drop files on the island, or hover it and press Ctrl+V to send what you copied. The other side accepts first, and everything is encrypted on the way.",
    icon: 'land',
    category: 'network',
    enabled: true,
    builtIn: true,
    priority: 'medium',
    // Persistent: a transfer stays on the pill while it goes (it is only active then).
    behavior: B(true, true, true, true),
    options: [
      {
        key: 'visible',
        type: 'toggle',
        label: 'Let computers nearby send me files',
        help: 'They see this computer and can offer it files; you accept each one. On Windows, allow Island through the firewall on private networks the first time it asks.',
        default: true,
      },
      { key: 'name', type: 'text', label: 'Name others see', help: "Empty: this computer's own name.", default: '', placeholder: "This computer's name" },
      {
        key: 'tile',
        type: 'toggle',
        label: 'Tile in Control Center',
        help: 'Land lives on the pill as a little icon. Turn this on for a Land tile in Control Center as well.',
        default: false,
      },
      {
        key: 'anywhere',
        type: 'toggle',
        label: 'Friends on other networks',
        help: "Friends you add with your Land code can reach this computer from anywhere. When a direct path is blocked, n0's free relays pass the encrypted bytes; they see that two Islands connect, not the files.",
        default: true,
      },
    ],
  },
  {
    id: 'timer',
    name: 'Timer',
    description: 'Timers, a stopwatch and focus sessions that live in the island.',
    icon: 'timer',
    category: 'productivity',
    enabled: true,
    priority: 'medium',
    behavior: B(true, true, true, true),
    options: [
      { key: 'focusMinutes', type: 'number', label: 'Focus length', default: 25, min: 5, max: 120, unit: 'min' },
      { key: 'breakMinutes', type: 'number', label: 'Break length', default: 5, min: 1, max: 60, unit: 'min' },
      {
        key: 'quietFocus',
        type: 'toggle',
        label: 'Quiet while focusing',
        help: "A focus round turns Quiet on: nothing pops up and notifications wait, in Island and in Windows. The break, or stopping, turns it off again. Quiet you turned on yourself is left alone.",
        default: true,
      },
    ],
  },  {
    id: 'reminders',
    name: 'Reminders',
    description: 'Type what and when ("submit the lab at 3pm", "stretch in 20m", "tomorrow 9am"). When it is time, the island shows it with Snooze and Done, and Windows notifies you.',
    icon: 'bell',
    category: 'productivity',
    enabled: true,
    priority: 'medium',
    behavior: B(true, false, true, true),
    options: [],
  },

  {
    id: 'battery',
    mac: 'soon',
    name: 'Battery',
    description: 'Plugging in, unplugging and low battery.',
    icon: 'battery',
    category: 'system',
    enabled: true,
    priority: 'low',
    behavior: B(true, false, false, true),
    options: [
      { key: 'lowAt', type: 'number', label: 'Warn at', default: 20, min: 5, max: 50, unit: '%' },
      { key: 'showCharging', type: 'toggle', label: 'Keep showing while charging', default: false },
    ],
  },
  {
    id: 'sound',
    mac: 'soon',
    name: 'Sound',
    description: 'Volume changes and audio devices, like headphones connecting.',
    icon: 'speaker',
    category: 'media',
    enabled: true,
    priority: 'low',
    behavior: B(true, false, true, false),
    options: [],
  },
  {
    id: 'screenshots',
    mac: 'soon',
    name: 'Screenshots',
    description: 'A new screenshot, with Copy, Open and Edit.',
    icon: 'screenshot',
    category: 'system',
    enabled: true,
    priority: 'medium',
    behavior: B(true, false, true, false),
    options: [{ key: 'preview', type: 'toggle', label: 'Thumbnail', default: true }],
  },
  {
    id: 'calls',
    mac: 'soon',
    name: 'Mic & Camera',
    description: 'Shows which apps use your microphone or camera, with a system-wide mute.',
    icon: 'mic',
    category: 'communication',
    enabled: true,
    priority: 'high',
    behavior: B(true, true, true, false),
    options: [],
  },
  {
    id: 'phone',
    mac: 'never',
    name: 'Phone',
    description:
      "Your phone's notifications on the island, through Windows' Phone Link: pair your iPhone or Android phone in the Phone Link app once. They wait in a list in Control Center, where you can read and dismiss them; turn on Persistent to keep the phone icon on the pill and see the list when you point at it.",
    icon: 'phone',
    category: 'communication',
    enabled: true,
    priority: 'high',
    behavior: B(true, false, true, false),
    options: [{ key: 'keepHours', type: 'number', label: 'Keep notifications for', help: 'Older ones leave the list on their own. They are never saved to disk.', default: 24, min: 1, max: 168, unit: 'h' }],
  },
  {
    id: 'devices',
    mac: 'soon',
    name: 'Devices',
    description: 'USB drives and other storage plugged in or removed.',
    icon: 'usb',
    category: 'system',
    enabled: true,
    priority: 'low',
    behavior: B(true, false, true, false),
    options: [],
  },
  {
    id: 'external',
    mac: 'soon',
    name: 'Other apps',
    description: 'Activities sent by scripts and other programs through the Island activity API.',
    icon: 'stack',
    category: 'developer',
    enabled: true,
    priority: 'medium',
    behavior: B(true, true, true, false),
    options: [],
  },
  {
    id: 'system',
    mac: 'soon',
    name: 'System Stats',
    description: 'CPU, memory and GPU. Quiet until something spikes, unless you keep it on.',
    icon: 'cpu',
    category: 'developer',
    enabled: false,
    priority: 'low',
    behavior: B(true, false, false, false),
    options: [
      {
        key: 'show',
        type: 'multi',
        label: 'On the pill',
        help: 'What the resting pill shows, side by side. Pointing at the pill or opening the island shows all three.',
        default: ['cpu'],
        choices: [
          { value: 'cpu', label: 'CPU' },
          { value: 'ram', label: 'RAM' },
          { value: 'gpu', label: 'GPU' },
        ],
      },
      { key: 'always', type: 'toggle', label: 'Always show', help: 'Keep the numbers on the island instead of only on spikes.', default: false },
      { key: 'cpuSpike', type: 'number', label: 'CPU spike at', default: 90, min: 50, max: 100, unit: '%' },
      { key: 'memSpike', type: 'number', label: 'Memory warning at', default: 92, min: 50, max: 100, unit: '%' },
    ],
  },
  {
    id: 'weather',
    name: 'Weather',
    description: 'Current conditions and rain coming soon, from Open-Meteo.',
    icon: 'cloud-sun',
    category: 'productivity',
    enabled: false,
    priority: 'low',
    behavior: B(true, true, false, false),
    options: [
      { key: 'city', type: 'text', label: 'City', default: '', placeholder: 'e.g. Montreal' },
      { key: 'units', type: 'choice', label: 'Units', default: 'celsius', choices: [{ value: 'celsius', label: '°C' }, { value: 'fahrenheit', label: '°F' }] },
    ],
  },
  {
    id: 'calendar',
    name: 'Calendar',
    description: 'Your next event, with a Join button for meeting links. Reads an iCal (ICS) link, or on Windows every calendar in your Windows accounts.',
    icon: 'calendar',
    category: 'productivity',
    enabled: false,
    priority: 'medium',
    behavior: B(true, true, true, true),
    options: [
      {
        key: 'source',
        type: 'choice',
        label: 'Where events come from',
        // A Mac reads the link only (calendar.ts), so there is nothing to choose.
        mac: 'never',
        default: 'windows',
        choices: [
          { value: 'windows', label: 'My Windows accounts' },
          { value: 'ics', label: 'A calendar link' },
        ],
        help: 'Windows accounts: every calendar you added in Windows Settings › Accounts (Outlook, Microsoft 365, Google, iCloud). Windows asks for calendar access the first time.',
      },
      { key: 'ics', type: 'text', label: 'Calendar link (ICS)', default: '', placeholder: 'https://calendar.google.com/…/basic.ics', secret: true, help: 'Used with "A calendar link" (always on a Mac). Google Calendar: Settings › your calendar › Secret address in iCal format. Outlook: Publish calendar › ICS.' },
      { key: 'leadMinutes', type: 'number', label: 'Show events this early', default: 15, min: 1, max: 120, unit: 'min' },
    ],
  },
  {
    id: 'clipboard',
    mac: 'soon',
    name: 'Clipboard',
    description: 'What you just copied, with Open and clipboard history. Passwords from password managers are skipped.',
    icon: 'clipboard',
    category: 'productivity',
    enabled: false,
    priority: 'low',
    behavior: B(true, false, true, false),
    options: [],
  },
  {
    id: 'network',
    mac: 'soon',
    name: 'Network',
    description: 'Connection drops and reconnects; optionally live download and upload speed.',
    icon: 'wifi',
    category: 'network',
    enabled: false,
    priority: 'low',
    behavior: B(true, false, false, false),
    options: [{ key: 'always', type: 'toggle', label: 'Always show speed', default: false }],
  },
  {
    id: 'workspaces',
    mac: 'soon',
    name: 'Workspaces',
    description: 'Shows a workspace opening on the pill and asks there before a command runs; puts your favorites in Control Center. Can also notice what you work on, show a workspace’s next step when you switch to it, and ask where you stopped when you leave.',
    icon: 'grid',
    category: 'productivity',
    enabled: true,
    priority: 'medium',
    // Interrupt: a restore that asks "Run npm run dev?" takes the island until answered.
    behavior: B(true, false, true, true),
    options: [
      {
        key: 'notice',
        type: 'toggle',
        label: 'Notice what I work on',
        help: 'Reads which app window is in front every few seconds to tell which workspace or project you’re in. Switching to a workspace shows its next step and notes, leaving one asks where you stopped, and a project you keep coming back to gets a workspace offer. Stays on this PC.',
        default: false,
      },
      { key: 'leaveNote', type: 'toggle', label: 'Ask where I stopped', help: 'When you leave a workspace you worked on for 10 minutes or more, the island asks for a note; it becomes the next step.', default: true },
      { key: 'suggest', type: 'toggle', label: 'Offer workspaces', help: 'A project you spend 20 minutes or more on in a day, with no workspace yet, gets a "make it a workspace" offer (once a day at most).', default: true },
      { key: 'titles', type: 'toggle', label: 'Keep window titles', help: 'Off: only what Island works out is kept (the program, the project and file names), never whole titles, which can hold email subjects or page names.', default: false },
      { key: 'days', type: 'number', label: 'Remember for', default: 14, min: 1, max: 60, unit: 'days' },
    ],
  },
  {
    id: 'servers',
    mac: 'soon',
    name: 'Local Servers',
    description: 'Dev servers listening on localhost (Node, Python, Bun…), with Open in browser.',
    icon: 'server',
    category: 'developer',
    enabled: false,
    priority: 'low',
    behavior: B(true, false, true, false),
    options: [],
  },
  {
    id: 'quick',
    mac: 'soon',
    name: 'Quick Actions',
    description: 'Mute, screenshot, focus, Bluetooth, Wi-Fi and lock, when you open an idle island.',
    icon: 'grid',
    category: 'system',
    enabled: false,
    priority: 'low',
    behavior: B(false, false, true, false),
    options: [],
  },
  {
    id: 'local',
    name: 'Bot chat',
    description: "Click the bot and ask it anything; Local or Claude answers, switched on the bar. Local is a model on your computer: nothing leaves it, and it works offline. Island recommends a model that suits your computer; download or switch models below, or use Ollama.",
    icon: 'spark',
    category: 'productivity',
    enabled: true,
    priority: 'medium',
    behavior: B(true, false, true, true),
    options: [
      // Set by the model list (src/models-ui.ts), not typed: 'island:<id>' is one of Island's own models, anything else an Ollama model, empty lets Island choose.
      { key: 'model', type: 'text', label: 'Model', help: 'Pick it in the model list.', default: '', placeholder: 'Let Island choose' },
      {
        key: 'backend',
        type: 'choice',
        label: 'Claude answers with',
        help: 'Claude Code uses your own Claude login and needs no key. The API key can search the web.',
        default: 'claude-code',
        choices: [
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'api', label: 'API key' },
        ],
      },
      { key: 'apiKey', type: 'secret', label: 'Anthropic API key', help: 'Only for the API key option. console.anthropic.com › API keys.', placeholder: 'sk-ant-…', secret: 'ask.apikey', default: '' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'CI runs that fail or pass on your repositories, review requests, and your stars at a glance.',
    icon: 'branch',
    category: 'developer',
    enabled: false,
    priority: 'medium',
    behavior: B(true, false, true, false),
    options: [
      { key: 'token', type: 'secret', label: 'Access token', help: 'github.com › Settings › Developer settings › Personal access tokens. Read access to repositories and Actions.', placeholder: 'ghp_… or github_pat_…', secret: 'github.token', default: '' },
      { key: 'repos', type: 'text', label: 'Repositories to watch', help: 'Up to five, separated by commas. Empty: your three most recently pushed repositories.', default: '', placeholder: 'owner/name, owner/name' },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'A deployment that starts, finishes or fails, and your latest deployments.',
    icon: 'globe',
    category: 'developer',
    enabled: false,
    priority: 'medium',
    behavior: B(true, false, true, false),
    options: [
      { key: 'token', type: 'secret', label: 'Access token', help: 'vercel.com › Account Settings › Tokens.', placeholder: 'Vercel token', secret: 'vercel.token', default: '' },
      { key: 'team', type: 'text', label: 'Team', help: 'A team slug or ID. Empty: your personal account.', default: '', placeholder: 'my-team or team_…' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'The pages you edited last. Share pages with your integration in Notion to see them.',
    icon: 'edit',
    category: 'productivity',
    enabled: false,
    priority: 'low',
    behavior: B(true, false, true, false),
    options: [
      { key: 'token', type: 'secret', label: 'Integration secret', help: 'notion.so/profile/integrations › your integration › Secret.', placeholder: 'ntn_… or secret_…', secret: 'notion.token', default: '' },
    ],
  },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((m) => [m.id, m]));
