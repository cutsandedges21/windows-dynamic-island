// Notion: the pages you edited last, in the open island, and as the pill's one line when you
// keep the activity on the island. There are no alerts: an edit is almost always your own.
// The poll (src-tauri/src/integrations.rs) searches the pages shared with your integration.

import { agoText } from '../../core/format';
import type { SheetRow } from '../../core/sheet';
import { IntegrationActivity, type TileContent } from './base';
import { parseTime, type Change, type Glance } from './util';

export interface NotionPage {
  id: string;
  title: string;
  emoji: string | null;
  lastEditedAt: string;
  url: string;
}

export interface NotionSnapshot {
  /** Most recently edited first. */
  pages: NotionPage[];
}

const nameOf = (p: NotionPage) => (p.emoji ? `${p.emoji} ${p.title}` : p.title);
const editedAgo = (p: NotionPage, now: number) => {
  const at = parseTime(p.lastEditedAt);
  return at === null ? '' : `Edited ${agoText(now - at)}`;
};

export function notionGlance(s: NotionSnapshot, now: number): Glance | null {
  const p = s.pages[0];
  return p ? { icon: 'edit', tone: 'muted', title: nameOf(p), detail: editedAgo(p, now), url: p.url } : null;
}

export function notionTile(s: NotionSnapshot, now: number): TileContent {
  const rows: SheetRow[] = s.pages.slice(0, 3).map((p) => ({ key: p.id, title: nameOf(p), detail: editedAgo(p, now), action: 'open', arg: p.url }));
  return { span: 2, rows: 2, tone: 'muted', body: { k: 'list', icon: 'edit', label: 'Notion', rows, empty: 'Share a page with your integration in Notion to see it here' } };
}

export class NotionActivity extends IntegrationActivity<NotionSnapshot> {
  constructor() {
    super('notion', { secret: 'notion.token', everyMs: 300_000, home: 'https://www.notion.so' });
  }

  protected compare(): Change[] {
    return [];
  }

  protected headline(s: NotionSnapshot, now: number): Glance | null {
    return notionGlance(s, now);
  }

  protected tileFor(s: NotionSnapshot, now: number): TileContent {
    return notionTile(s, now);
  }
}
