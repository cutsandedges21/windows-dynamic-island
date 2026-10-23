// Notifications from the PC (phase 3): Web Push straight from Island, for the Home Screen app.
// The island's hello carries its VAPID key; this phone's subscription goes back in a `push-sub`
// line and is kept per PC. The service worker (public/sw.js) shows the pushes.

import type { PushSub } from '../../../src/remote/protocol';
import { standalone } from './ui';

export type PushState =
  | { kind: 'unsupported' | 'needs-app' | 'needs-pc' | 'blocked'; text: string }
  | { kind: 'off' | 'on'; text: string };

const flag = (id: string) => `island:phone:push:${id}`;

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Whether notifications can be on for this PC, and whether they are. */
export async function pushState(islandId: string, vapid: string | null): Promise<PushState> {
  if (!standalone()) return { kind: 'needs-app', text: 'Notifications work in the Home Screen app (iOS 16.4 or later).' };
  if (!supported()) return { kind: 'unsupported', text: "This browser can't show notifications from a website." };
  if (!vapid) return { kind: 'needs-pc', text: 'Update Island on your PC to get its notifications here.' };
  if (Notification.permission === 'denied') return { kind: 'blocked', text: 'Notifications are off for Island in Settings › Notifications.' };
  const sub = await currentSub();
  const on = sub !== null && Notification.permission === 'granted' && localStorage.getItem(flag(islandId)) === '1';
  return on ? { kind: 'on', text: 'Claude, timers and the other moments Island would send to your phone.' } : { kind: 'off', text: 'Get the moments Island would send to your phone, straight from your PC.' };
}

async function currentSub(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The subscription as the island keeps it; null if it lacks its keys. */
export function subOf(json: PushSubscriptionJSON): PushSub | null {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Asks for permission (from a tap) and subscribes; the caller sends the result in `push-sub`. */
export async function pushOn(islandId: string, vapid: string): Promise<PushSub> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('./sw.js'));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another key can't take this island's pushes.
  const want = keyBytes(vapid);
  const has = sub?.options.applicationServerKey;
  if (sub && has && !sameBytes(new Uint8Array(has), want)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  const out = subOf(sub.toJSON());
  if (!out) throw new Error("The subscription came back without its keys.");
  localStorage.setItem(flag(islandId), '1');
  return out;
}

/** Stops this PC's notifications (the caller sends `push-sub` null). Other PCs keep the subscription. */
export async function pushOff(islandId: string, othersOn: boolean): Promise<void> {
  localStorage.removeItem(flag(islandId));
  if (othersOn) return;
  const sub = await currentSub();
  await sub?.unsubscribe();
}

/** On connecting: the subscription again, if this PC has notifications on (it may have changed). */
export async function pushResend(islandId: string): Promise<PushSub | null> {
  if (!supported() || localStorage.getItem(flag(islandId)) !== '1' || Notification.permission !== 'granted') return null;
  const sub = await currentSub();
  return sub ? subOf(sub.toJSON()) : null;
}

/** Whether `id` has notifications on (for the menu, and to keep the subscription for others). */
export function pushFlag(id: string): boolean {
  return localStorage.getItem(flag(id)) === '1';
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
