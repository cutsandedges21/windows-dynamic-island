// What the Workspaces page's views share: the store, where the page is, and the state that
// outlives a redraw (a search, a half-typed note, an edit in progress).

import type { WorkspaceCheck } from './checks';
import type { Workspace, WsSort } from './model';
import type { Answer, Job } from './restore';
import type { WorkspaceStore } from './store';
import type { WsSpan } from './time';

/** The front page's two tabs: where the time went, and the cards. */
export type WsTab = 'time' | 'cards';

/** The Time tab's state between redraws. */
export interface TimeState {
  /** Weeks back from this one. */
  back: number;
  /** The day picked in the bars (0 = Sunday), or null for the whole week. */
  day: number | null;
  /** The last spans fetched, the week they're for (its start) and when. */
  spans: WsSpan[] | null;
  for: number;
  at: number;
  loading: boolean;
  /** Just switched to: the bars grow in once. */
  fresh: boolean;
}

/** Notice what I work on, as the Time tab needs it (the Activities window owns the settings). */
export interface Noticing {
  /** Switched on, with the Workspaces activity. */
  on(): boolean;
  /** How many days it keeps. */
  days(): number;
  turnOn(): void;
}

export interface EditState {
  draft: Workspace;
  isNew: boolean;
  dirty: boolean;
  /** Items shown open. */
  open: Set<string>;
  check: WorkspaceCheck | null;
  /** Where Cancel goes. */
  back: View;
  /** When the edit was brought back from before the window closed. */
  restoredFrom: number | null;
  /** Save was pressed without a name. */
  nameMissing: boolean;
}

export type View = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'edit'; edit: EditState };

/** An edit kept in the browser's storage until saved or thrown away. */
export interface SavedDraft {
  draft: Workspace;
  isNew: boolean;
  at: number;
}

export interface Ui {
  query: string;
  sort: WsSort;
  showArchived: boolean;
  /** Notes being typed, per workspace, until saved. */
  notes: Map<string, { text: string; next: string }>;
  /** Item checks per workspace, with the edit time they were made for. */
  checks: Map<string, { at: number; result: WorkspaceCheck }>;
  /** An edit that wasn't saved before the window closed. */
  pendingDraft: SavedDraft | null;
  listScroll: number;
  /** The island's restore job, as its last 'ws-job' event said. */
  job: Job | null;
  /** A finished job the user closed on the workspace's page. */
  jobClosed: string | null;
  tab: WsTab;
  time: TimeState;
  /** Workspaces with a window open now (detect.ts workspacesInUse), checked while the page shows. */
  inUse: Set<string>;
}

export interface Ctx {
  store: WorkspaceStore;
  ui: Ui;
  view: View;
  accent(): string;
  go(view: View): void;
  paint(): void;
  /** Opens everything in a workspace (the island does it); null outside the app. */
  restore: ((ws: Workspace) => void) | null;
  /** Answers the question the running restore asks. */
  answer(step: string, a: Answer): void;
  cancel(): void;
  retry(): void;
  noticing: Noticing;
  /** When each workspace was in front between two moments: the island's record, else the file's. */
  spans(since: number, until: number): Promise<WsSpan[]>;
}
