// Keys and tokens in the Windows Credential Manager, as the webview sees them: is one
// saved, save one, remove one. A value goes in and never comes back; only Rust (the
// integration pollers and the Ask Claude call) reads it, and settings.json never holds it.

import { bridge, type SecretResult } from './bridge';

export type { SecretResult };

/** The rule secrets.rs applies: `<activity>.<option>`, letters, digits, dot, dash, underscore. */
export const SECRET_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function secretHas(name: string): Promise<boolean> {
  return SECRET_NAME.test(name) ? bridge.secretHas(name) : Promise.resolve(false);
}

export async function secretSet(name: string, value: string): Promise<SecretResult> {
  if (!SECRET_NAME.test(name)) return { ok: false, error: 'That is not a valid secret name' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'Paste the key first' };
  return bridge.secretSet(name, trimmed);
}

export async function secretDelete(name: string): Promise<SecretResult> {
  if (!SECRET_NAME.test(name)) return { ok: false, error: 'That is not a valid secret name' };
  return bridge.secretDelete(name);
}
