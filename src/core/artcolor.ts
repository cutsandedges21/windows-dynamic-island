// The music bars' colour, from the album art, as on an iPhone: the art's main vivid colour,
// made light enough to glow on a dark pill (or dark enough to read on a light one). Grey or
// black-and-white art has none, and the bars keep the accent.

/** Pixels across the art is shrunk to before reading it: plenty for one colour. */
const SAMPLE = 24;
/** Hue buckets the colours are sorted into. */
const BUCKETS = 18;
/** Less vivid colour than this, all buckets together, and the art counts as grey. */
const MIN_VIVID = 0.06;

type Rgb = [number, number, number];

function hsl([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  let h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/**
 * The art's main vivid colour from its pixels (RGBA, row by row), as an HSL triple, or null
 * for grey art. Each pixel weighs by how vivid it is (saturated, neither near black nor near
 * white); the hue bucket with the most weight wins and its pixels are averaged.
 */
export function vividColour(rgba: ArrayLike<number>): [number, number, number] | null {
  const weight = new Array<number>(BUCKETS).fill(0);
  const sum: Array<[number, number, number]> = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  let total = 0;
  let pixels = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    pixels++;
    const [h, s, l] = hsl([rgba[i], rgba[i + 1], rgba[i + 2]]);
    const w = s * (1 - Math.abs(2 * l - 1)) ** 2;
    if (w <= 0) continue;
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    weight[k] += w;
    // Hues are averaged as vectors, so reds either side of 0° do not average to cyan.
    sum[k][0] += Math.cos((h * Math.PI) / 180) * w;
    sum[k][1] += Math.sin((h * Math.PI) / 180) * w;
    sum[k][2] += s * w;
    total += w;
  }
  if (!pixels || total / pixels < MIN_VIVID) return null;
  let best = 0;
  for (let k = 1; k < BUCKETS; k++) if (weight[k] > weight[best]) best = k;
  // A bucket's neighbours count towards it, so a hue on a bucket edge is not split in two.
  const near = [best - 1, best, best + 1].map((k) => (k + BUCKETS) % BUCKETS);
  let x = 0;
  let y = 0;
  let s = 0;
  let w = 0;
  for (const k of near) {
    x += sum[k][0];
    y += sum[k][1];
    s += sum[k][2];
    w += weight[k];
  }
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return [h, s / w, 0.5];
}

/** The colour the bars are drawn in on a dark pill (`light` false) or a light one. */
export function barColour(c: [number, number, number], light: boolean): string {
  const [h, s] = c;
  const sat = Math.round(Math.max(0.55, Math.min(0.95, s)) * 100);
  return `hsl(${Math.round(h)} ${sat}% ${light ? 42 : 60}%)`;
}

const cache = new Map<string, [number, number, number] | null>();

/** The art's colour (see vividColour); null for grey art or art that does not load. Cached by source. */
export async function artColour(src: string): Promise<[number, number, number] | null> {
  if (cache.has(src)) return cache.get(src)!;
  const found = await new Promise<[number, number, number] | null>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        resolve(vividColour(g.getImageData(0, 0, SAMPLE, SAMPLE).data));
      } catch {
        resolve(null); // a tainted canvas: art from somewhere that does not allow reading it
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  // A few tracks' worth is plenty: art arrives as data URLs, which are big.
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  cache.set(src, found);
  return found;
}
