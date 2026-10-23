// The hub's native calls (src/remote/hub.ts), from src/core/native.ts. Kept apart so the hub
// itself never imports Tauri and its tests hand it a fake.

import { native, on } from '../core/native';
import type { PhoneNative } from './hub';

export const phoneNative: PhoneNative = {
  phones: () => native.remotePhones(),
  send: (phone, msg) => native.remoteSend(phone, msg),
  vapid: () => native.remoteVapid(),
  push: (title, body, tag, open, urgent) => native.remotePush(title, body, tag, open, urgent),
  copy: (text) => native.clipboardSetText(text),
  clipboard: () => native.clipboardPaste(),
  lock: () => native.lock(),
  log: (text) => void native.log(text),
  on: (event, cb) => on(event, cb),
};
