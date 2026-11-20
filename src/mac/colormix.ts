// CSS color-mix() for Safari before 16.2 (macOS 12's own Safari can be older). Island's styles tint
// with `color-mix(in srgb, var(--accent) 18%, transparent)`: an engine without color-mix() drops
// that at draw time, and selected buttons, tints and borders lose their colour. Here every colour
// variable gets an `-rgb` twin (its channels), and each color-mix() becomes the rgba() of its first
// colour at its share; mixing two colours keeps the first one's (close enough for tints). Runs only
// where color-mix() is missing (src/mac/compat.ts loads it in the Mac build).

/** "r, g, b" of a CSS colour the engine knows; null for anything else (a var(), a gradient). */
type Channels = (css: string) => string | null;

/** Splits on commas that aren't inside brackets. */
export function topLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

/** "var(--accent) 18%" → ["var(--accent)", 0.18]; no percentage → null share. */
function colorAndShare(arg: string): [string, number | null] {
  const m = /^(.*?)\s+(-?[\d.]+)%$/.exec(arg.trim());
  return m ? [m[1].trim(), Math.max(0, Math.min(1, Number(m[2]) / 100))] : [arg.trim(), null];
}

/** A colour as channels to put in rgba(): a variable's `-rgb` twin, or a literal colour's own. */
function channelsOf(color: string, channels: Channels): string | null {
  const v = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(color);
  if (v) {
    const fallback = v[2] ? channels(v[2]) : null;
    return fallback ? `var(${v[1]}-rgb, ${fallback})` : `var(${v[1]}-rgb)`;
  }
  return channels(color);
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** One color-mix()'s arguments as what an old engine can draw. */
function mixOf(args: string, channels: Channels): string {
  const parts = topLevel(args);
  if (parts.length < 3) return 'transparent';
  let [a, pa] = colorAndShare(parts[1]);
  let [b, pb] = colorAndShare(parts[2]);
  // color-mix() shares: one given, the other is the rest; none given, half each.
  if (pa == null && pb == null) pa = pb = 0.5;
  else if (pa == null) pa = 1 - (pb as number);
  else if (pb == null) pb = 1 - pa;
  const clear = (c: string) => c === 'transparent';
  // The colour that counts is the one that isn't transparent; with two colours, the first at its
  // share over what is behind it (close to the mix for the light tints Island uses).
  if (clear(a) && !clear(b)) [a, pa] = [b, pb];
  const ch = channelsOf(a, channels);
  return ch ? `rgba(${ch}, ${fmt(pa as number)})` : a;
}

/** Every color-mix() in a CSS value (or a whole cssText), innermost first. */
export function withoutColorMix(css: string, channels: Channels): string {
  let out = css;
  for (let guard = 0; guard < 200; guard++) {
    const at = out.lastIndexOf('color-mix(');
    if (at < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = at + 'color-mix'.length; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    out = out.slice(0, at) + mixOf(out.slice(at + 'color-mix('.length, end), channels) + out.slice(end + 1);
  }
  return out;
}

/** The `-rgb` twin of a colour variable's value: channels, or the twin of the variable it names. */
export function twinOf(value: string, channels: Channels): string | null {
  const v = value.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (ref) return channelsOf(v, channels);
  if (v.includes('color-mix(')) {
    const mixed = withoutColorMix(v, channels);
    const m = /^rgba\((.+),\s*[\d.]+\)$/.exec(mixed);
    return m ? m[1] : null;
  }
  return channels(v);
}

/** The engine's own reading of a colour, through a canvas: "r, g, b". */
function canvasChannels(): Channels {
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  const cache = new Map<string, string | null>();
  return (css: string) => {
    const key = css.trim();
    if (!key || key.includes('var(') || key.includes('(') && !/^(rgba?|hsla?)\(/.test(key)) return null;
    if (cache.has(key)) return cache.get(key)!;
    let out: string | null = null;
    if (ctx) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = key;
      const got = String(ctx.fillStyle);
      if (got !== '#010203' || key === '#010203') {
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(got);
        const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(got);
        if (hex) out = `${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)}`;
        else if (rgb) out = `${rgb[1]}, ${rgb[2]}, ${rgb[3]}`;
      }
    }
    cache.set(key, out);
    return out;
  };
}

/** A rule's declarations with the twins added and the color-mix()es drawn the old way. */
export function fixDeclarations(css: string, channels: Channels): string | null {
  let extra = '';
  const decl = /(--[\w-]+)\s*:\s*([^;]+);?/g;
  for (let m = decl.exec(css); m; m = decl.exec(css)) {
    if (m[1].endsWith('-rgb')) continue;
    const twin = twinOf(m[2], channels);
    if (twin && !css.includes(`${m[1]}-rgb:`)) extra += ` ${m[1]}-rgb: ${twin};`;
  }
  const mixed = css.includes('color-mix(') ? withoutColorMix(css, channels) : css;
  if (!extra && mixed === css) return null;
  return `${mixed}${mixed.trim().endsWith(';') || !mixed.trim() ? '' : ';'}${extra}`;
}

function fixSheet(sheet: CSSStyleSheet, channels: Channels): void {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return;
  }
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        const next = fixDeclarations(rule.style.cssText, channels);
        if (next != null) rule.style.cssText = next;
      } else if ('cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  walk(rules);
}

/** Turns the fallback on: the sheets there are, those that come later, and colours set from code. */
export function installColorMix(doc: Document): void {
  const channels = canvasChannels();
  const done = new WeakSet<CSSStyleSheet>();
  const sweep = () => {
    for (const s of Array.from(doc.styleSheets)) {
      if (done.has(s)) continue;
      done.add(s);
      fixSheet(s, channels);
    }
  };
  sweep();
  new MutationObserver(() => sweep()).observe(doc.head ?? doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener('load', () => sweep(), true);
  // Colours the code sets (the accent, a tile's tint): their twins too, and their own color-mix()es.
  const set = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
    let v = value;
    if (typeof v === 'string' && v.includes('color-mix(')) v = withoutColorMix(v, channels);
    set.call(this, name, v, priority ?? '');
    if (name.startsWith('--') && !name.endsWith('-rgb') && typeof v === 'string') {
      const twin = twinOf(v, channels);
      if (twin) set.call(this, `${name}-rgb`, twin, '');
    }
  };
}

if (typeof CSS !== 'undefined' && typeof document !== 'undefined' && !CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')) {
  installColorMix(document);
}
