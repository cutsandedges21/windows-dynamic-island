// Windows Hello (fingerprint, face or PIN) through the biometry plugin. Island asks for
// it before a saved key is replaced or removed. The plugin's status and authenticate
// calls are all it needs; nothing is stored in the plugin.

import { authenticate, checkStatus } from '@choochmeque/tauri-plugin-biometry-api';
import { inTauri } from './bridge';

export interface HelloStatus {
  available: boolean;
  /** Why not, when it is not available. */
  reason?: string;
}

/** Asking Windows is quick, but the Activities page asks once per secret row. */
const STATUS_TTL_MS = 30_000;
let cached: { at: number; status: HelloStatus } | null = null;

export async function helloStatus(): Promise<HelloStatus> {
  if (!inTauri) return { available: false, reason: 'Windows Hello needs the Island app' };
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  let status: HelloStatus;
  try {
    const s = await checkStatus();
    status = s.isAvailable ? { available: true } : { available: false, reason: s.error || 'Windows Hello is not set up on this PC' };
  } catch {
    status = { available: false, reason: 'Windows Hello could not be reached' };
  }
  cached = { at: Date.now(), status };
  return status;
}

/** True only when the user authenticates. Cancelled, failed or unavailable are all false. */
export async function requireHello(reason: string): Promise<boolean> {
  if (!(await helloStatus()).available) return false;
  try {
    await authenticate(reason, { allowDeviceCredential: true, cancelTitle: 'Cancel' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate for replacing or removing a key: Windows Hello when this PC has it, otherwise
 * nothing to ask. False means Hello is there and the user did not pass it.
 */
export async function confirmWithHello(reason: string): Promise<boolean> {
  return (await helloStatus()).available ? requireHello(reason) : true;
}
