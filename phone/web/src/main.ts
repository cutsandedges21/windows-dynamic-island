// Island on your phone: the website's entry. It draws with the island's own CSS and renderers,
// and talks to the PC through the link (phone/web/src/link, iroh in WebAssembly). Until that is
// built into the site, and always with ?demo, a pretend PC stands in (dev/fake-link.ts).
//
//   ?demo            the pretend PC (fresh every load); &urgent: Claude asks at once;
//                    &offline: it never answers; &pair: start unpaired; &install: the
//                    Add to Home Screen screen; &two: a second pretend PC (MossDesktop) to
//                    switch to in More
//   #pair=<code>     a pairing code (the QR code on the PC opens this)
//   ?open=<activity> that activity's card (a tapped notification)

import '../../../src/styles/island.css';
import '../../../src/styles/player.css';
import './phone.css';
import { decodePair } from '../../../src/remote/protocol';
import { App } from './app';
import { DEMO_ISLAND, DESKTOP_ISLAND, FakeLink } from './dev/fake-link';
import type { CreateLink, Link } from './link/api';
import { pairInLocation } from './pairing';
import { IslandStore, type KeyValue } from './store';
import { button, h, standalone } from './ui';

const params = new URLSearchParams(location.search);
/** A pairing code from the address, kept for this tab until it is used (Add to Home Screen comes first). */
const PENDING_KEY = 'island:phone:pending-pair';
const IN_BROWSER_KEY = 'island:phone:in-browser';

/** The link, if it is built into the site (phone/web/src/link/index.ts); a glob finds nothing otherwise. */
const linkModule = import.meta.glob<{ createLink: CreateLink }>('./link/index.ts');

function memory(): KeyValue {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function session(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage off: nothing kept */
  }
  return null;
}

function failed(root: HTMLElement, err: unknown): void {
  root.replaceChildren(
    h('main', { class: 'ph-screen ph-pair' }, [
      h('img', { class: 'ph-app-icon small', src: './icons/icon-192.png', alt: '' }),
      h('h1', { class: 'ph-h1', text: "Island couldn't start" }),
      h('p', { class: 'ph-lead', text: 'The part that connects to your PC failed to load. Check the connection, then reload.' }),
      h('p', { class: 'ph-small', text: err instanceof Error ? err.message : String(err) }),
      h('div', { class: 'ph-actions' }, [button('Reload', { icon: 'refresh', style: 'primary', onclick: () => location.reload() })]),
    ]),
  );
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;

  // A code in the address: kept for this tab, and taken out of the address at once (so it is
  // neither bookmarked nor added to the Home Screen).
  const found = pairInLocation(location);
  let pending = found.pair;
  if (found.found) {
    const raw = location.hash.includes('pair=') ? location.hash : location.search;
    session(PENDING_KEY, found.pair ? raw : null);
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.delete('pair');
    history.replaceState(null, '', url);
  } else {
    const kept = session(PENDING_KEY);
    pending = kept ? decodePair(kept) : null;
  }

  let demo = params.has('demo');
  let notice: string | null = null;
  let link: Link;
  if (demo) link = new FakeLink({ urgent: params.has('urgent'), offline: params.has('offline') });
  else {
    const load = linkModule['./link/index.ts'];
    if (load) {
      try {
        link = await (await load()).createLink();
      } catch (err) {
        console.error('the link failed to start', err);
        failed(root, err);
        return;
      }
    } else {
      demo = true;
      notice = "A demo: this build of the site can't connect to a PC yet.";
      link = new FakeLink({ urgent: params.has('urgent'), offline: params.has('offline') });
    }
  }

  // The demo starts afresh every time and never touches a real pairing.
  const store = new IslandStore(demo ? memory() : localStorage);
  if (demo && !params.has('pair') && !pending && !found.found) {
    // Added first, so MossLaptop (added last) is the one that opens.
    if (params.has('two')) store.add({ ...DESKTOP_ISLAND, lastSeen: Date.now() - 25 * 60_000 });
    store.add({ ...DEMO_ISLAND, lastSeen: Date.now() - 4 * 60_000 });
  }

  const install = !standalone() && session(IN_BROWSER_KEY) !== '1' && (!demo || params.has('install'));
  if (!install) session(PENDING_KEY, null);

  new App(root, link, store, {
    demo,
    notice,
    install,
    pending,
    pendingBroken: found.found && !found.pair,
    open: params.get('open'),
    version: __APP_VERSION__,
  }).start();
}

// The service worker keeps the app's shell for a quick start and shows the PC's notifications.
// Not in development: a cached shell would hide every edit.
if ('serviceWorker' in navigator && (import.meta.env.PROD || params.has('sw'))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err: unknown) => console.warn('service worker', err));
  });
}

void boot();
