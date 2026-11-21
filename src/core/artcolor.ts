// The music bars' colour, from the album art, as on an iPhone: the art's main vivid colour,
// made light enough to glow on a dark pill (or dark enough to read on a light one). Grey or
// black-and-white art has none, and the bars keep the accent.

/** Pixels across the art is shrunk to before reading it: plenty for one colour. */
const SAMPLE = 24;
/** Hue buckets the colours are sorted into. */
const BUCKETS = 18;
/**
 * Less vivid colour than this, all buckets together, and the art counts as grey. Mostly pale or dark
 * art with some colour in it still has one (Moss, 11-20: Korn's See You on the Other Side, 0.0596,
 * and The Weeknd's After Hours, 0.05, came out grey at 0.06 and the island kept its own colour).
 */
const MIN_VIVID = 0.03;

/** Less saturated than this, a colour is grey: kept grey, not pushed into its (meaningless) hue. */
const GREY = 0.04;

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
 * The art's main colour from its pixels (RGBA, row by row), as an HSL triple; null only with no
 * pixels. Each pixel weighs by how vivid it is (saturated, neither near black nor near white); the
 * hue bucket with the most weight wins and its pixels are averaged. Art with too little colour for
 * that (black and white, all grey) gives its average colour, grey or nearly: while a song plays there
 * is always a colour, never the pill's own (Moss, 11-20: "there must ALWAYS be a colour").
 */
export function vividColour(rgba: ArrayLike<number>): [number, number, number] | null {
  const weight = new Array<number>(BUCKETS).fill(0);
  const sum: Array<[number, number, number, number]> = Array.from({ length: BUCKETS }, () => [0, 0, 0, 0]);
  let total = 0;
  let pixels = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    pixels++;
    mean[0] += rgba[i];
    mean[1] += rgba[i + 1];
    mean[2] += rgba[i + 2];
    const [h, s, l] = hsl([rgba[i], rgba[i + 1], rgba[i + 2]]);
    const w = s * (1 - Math.abs(2 * l - 1)) ** 2;
    if (w <= 0) continue;
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    weight[k] += w;
    // Hues are averaged as vectors, so reds either side of 0° do not average to cyan.
    sum[k][0] += Math.cos((h * Math.PI) / 180) * w;
    sum[k][1] += Math.sin((h * Math.PI) / 180) * w;
    sum[k][2] += s * w;
    sum[k][3] += l * w;
    total += w;
  }
  if (!pixels) return null;
  if (total / pixels < MIN_VIVID) return hsl([mean[0] / pixels, mean[1] / pixels, mean[2] / pixels]);
  let best = 0;
  for (let k = 1; k < BUCKETS; k++) if (weight[k] > weight[best]) best = k;
  // A bucket's neighbours count towards it, so a hue on a bucket edge is not split in two.
  const near = [best - 1, best, best + 1].map((k) => (k + BUCKETS) % BUCKETS);
  let x = 0;
  let y = 0;
  let s = 0;
  let l = 0;
  let w = 0;
  for (const k of near) {
    x += sum[k][0];
    y += sum[k][1];
    s += sum[k][2];
    l += sum[k][3];
    w += weight[k];
  }
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return [h, s / w, l / w];
}

/** How bright an HSL colour looks, 0 (black) to 1 (white): WCAG's relative luminance. */
export function luminance([h, s, l]: [number, number, number]): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}

/**
 * The taskbar's now playing section filled with the album's own colour (Moss, 11-20: the whole
 * section, behind the buttons too): its hue, saturation and lightness, kept from going muddy or
 * glaring; `light` when it is light enough that the buttons and the text on it go black.
 */
export function songFill(c: [number, number, number]): { fill: string; light: boolean } {
  const [h, s0, l0] = c;
  const s = s0 < GREY ? s0 : Math.max(0.35, Math.min(0.9, s0));
  const l = Math.max(0.3, Math.min(0.8, l0));
  return { fill: `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`, light: luminance([h, s, l]) > 0.4 };
}

/** The colour the bars are drawn in on a dark pill (`light` false) or a light one. */
export function barColour(c: [number, number, number], light: boolean): string {
  const [h, s] = c;
  const sat = Math.round((s < GREY ? s : Math.max(0.55, Math.min(0.95, s))) * 100);
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

/** The album colour fades from one song to the next, and out, over this long (island.css --isl-song). */
export const SONG_FADE_MS = 600;
const fadingOut = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Puts the album colour in custom property `prop` on `root` (registered as a colour in island.css, so
 * it fades from one song to the next instead of snapping; Moss, 11-20: "blend smoothly"). With none,
 * it fades to clear first: the answer stays true until it has, so the caller keeps the classes that
 * draw it till then, and `again` runs once it has, to take them off. A new song while it fades (the
 * moment between a song and its art being read) fades straight to the new colour.
 */
export function songFade(root: HTMLElement, prop: string, colour: string | null, again: () => void): boolean {
  const st = root.style;
  const timer = fadingOut.get(prop);
  if (colour) {
    if (timer !== undefined) clearTimeout(timer);
    fadingOut.delete(prop);
    st.setProperty(prop, colour);
    return true;
  }
  if (timer !== undefined) return true;
  const was = st.getPropertyValue(prop);
  if (!was || was === 'transparent') return false;
  st.setProperty(prop, 'transparent');
  fadingOut.set(
    prop,
    setTimeout(() => {
      fadingOut.delete(prop);
      again();
    }, SONG_FADE_MS),
  );
  return true;
}
