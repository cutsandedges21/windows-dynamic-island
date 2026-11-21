// The Glass pill's Clear ↔ Tinted slider (Settings › Appearance › Glass), like iOS Liquid Glass.
// Its own module, so the Duplicate copies and the phone can draw it without loading the settings
// schema and the activity catalog behind it.

/** The glass slider where it starts: the faint smoke the glass always had. */
export const GLASS_DEFAULT = 11;
/** Where the slider's middle lands on the 0–1 scale: a frosted glass. */
const GLASS_MID = 0.736;
/** Up to this tint the glass only darkens a little (its old smoke); past it a frosted grey fills in. */
const GLASS_SMOKE = 0.16;

/**
 * The glass slider (0–100) on a 0–1 scale. Not a straight line: the middle of the slider is
 * GLASS_MID, a frosted glass, so the frosted end gets half the slider. Anything that is not a
 * number (a phone hearing from an older Island) is the default.
 */
export function glassTint(glass: number | undefined): number {
  const v = typeof glass === 'number' && Number.isFinite(glass) ? Math.max(0, Math.min(100, glass)) : GLASS_DEFAULT;
  return v <= 50 ? (v / 50) * GLASS_MID : GLASS_MID + ((v - 50) / 50) * (1 - GLASS_MID);
}

/**
 * The glass's two see-through layers for a slider value, as the CSS variables island.css draws
 * them with: a smoke that stays faint, then a frosted grey that fills in, so less of the desktop
 * shows through without the glass going black (the page cannot blur what is behind it). Worked
 * out here rather than with calc() inside the colour, which an older Safari (a phone) drops.
 */
export function glassStyle(glass: number | undefined): Record<'--glass-smoke' | '--glass-frost', string> {
  const t = glassTint(glass);
  const smoke = 0.06 + Math.min(t, GLASS_SMOKE) * 0.75;
  const frost = Math.max(0, t - GLASS_SMOKE) / (1 - GLASS_SMOKE);
  return { '--glass-smoke': smoke.toFixed(3), '--glass-frost': frost.toFixed(3) };
}

/** Sets the glass on a page (the island, a Duplicate copy, the phone); every glass surface follows. */
export function applyGlass(root: HTMLElement, glass: number | undefined): void {
  for (const [name, value] of Object.entries(glassStyle(glass))) root.style.setProperty(name, value);
}

/** Pill colour › Custom, before one is picked: a deep blue. */
export const CUSTOM_DEFAULT = '#1f4fbf';

/** A saved custom colour as #rrggbb, or the default for anything else. */
export function pillHex(v: unknown): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : CUSTOM_DEFAULT;
}

/** Light enough that dark text reads better on it than white (WCAG relative luminance). */
export function hexIsLight(hex: string | undefined): boolean {
  const c = pillHex(hex);
  const lin = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  // Where black text and white text have the same contrast.
  return l > 0.179;
}

/**
 * Sets the pill's colour on a page: data-pill for the look, and for Custom the colour itself
 * (--custom-pill) and whether it is light (data-tone), so text goes dark on it as on White.
 */
export function applyPill(root: HTMLElement, color: string, custom?: string): void {
  root.dataset.pill = color;
  if (color === 'custom') {
    const hex = pillHex(custom);
    root.style.setProperty('--custom-pill', hex);
    root.dataset.tone = hexIsLight(hex) ? 'light' : 'dark';
  } else {
    root.style.removeProperty('--custom-pill');
    delete root.dataset.tone;
  }
}

/** The pill is a light one (White, Matte white, a light Custom): what sits on it goes dark. */
export function pillIsLight(root: HTMLElement): boolean {
  return /white/.test(root.dataset.pill ?? '') || root.dataset.tone === 'light';
}
