// Scanning the pairing code: the back camera in a full-screen view, frames decoded in the page
// (the browser's BarcodeDetector where it has one, jsQR otherwise; iOS Safari has none). The
// first code that holds a pairing link wins; any other code says so and scanning goes on.

import { readPairInput } from '../pairing';
import type { PairPayload } from '../../../../src/remote/protocol';
import { button, h } from '../ui';

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

type Decode = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<string | null>;

async function decoder(): Promise<Decode> {
  const Native = (globalThis as { BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (Native) {
    try {
      const formats = (await Native.getSupportedFormats?.()) ?? ['qr_code'];
      if (formats.includes('qr_code')) {
        const d = new Native({ formats: ['qr_code'] });
        return async (canvas) => (await d.detect(canvas))[0]?.rawValue ?? null;
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const { default: jsQR } = await import('jsqr');
  return async (canvas, ctx) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  };
}

/** Why the camera couldn't start, in plain words. */
export function cameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Island needs the camera to scan the code. Allow it (iPhone: Settings › Safari › Camera, or the aA menu › Website Settings), or paste the link instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera here. Paste the pairing link instead.';
  if (!window.isSecureContext) return 'The camera only works on the https site.';
  return "The camera didn't start. Paste the pairing link instead.";
}

/** Opens the scanner over everything; resolves with a pairing payload, or null when cancelled. */
export function scan(onError: (text: string) => void): Promise<PairPayload | null> {
  return new Promise((resolve) => {
    const video = h('video', { class: 'ph-scan-video', playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
    video.muted = true;
    const status = h('div', { class: 'ph-scan-status', text: 'Point at the code on your PC' });
    const el = h('div', { class: 'ph-scan', role: 'dialog', 'aria-label': 'Scan the code' }, [
      video,
      h('div', { class: 'ph-scan-frame' }),
      h('div', { class: 'ph-scan-bottom' }, [status, button('Cancel', { style: 'secondary', onclick: () => finish(null) })]),
    ]);
    document.body.append(el);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream: MediaStream | null = null;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (p: PairPayload | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const t of stream?.getTracks() ?? []) t.stop();
      el.remove();
      resolve(p);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia || !ctx) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (done) return finish(null);
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const decode = await decoder();
      const loop = async () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          // At most 720 px across: plenty for a code that fills the frame, and fast.
          const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * k);
          canvas.height = Math.round(video.videoHeight * k);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          let text: string | null = null;
          try {
            text = await decode(canvas, ctx);
          } catch {
            text = null;
          }
          if (text) {
            const r = readPairInput(text);
            if (r.ok) return finish(r.pair);
            status.textContent = "That's not Island's pairing code. Point at the one in Settings › Your phone.";
          }
        }
        timer = setTimeout(() => void loop(), 120);
      };
      void loop();
    };
    start().catch((err: unknown) => {
      finish(null);
      onError(cameraError(err));
    });
  });
}
