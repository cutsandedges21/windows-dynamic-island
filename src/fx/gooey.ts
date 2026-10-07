// ensureGooeyFilter: the "liquid" SVG filter from Libraries.dev's liquid-gooey (MIT, Jakub
// Antalik): blur the shapes, push the blurred alpha through a steep threshold, then paint the
// original shapes atop the result. Shapes that come within about `blur` px of each other grow a
// smooth neck and merge, and pull apart again the same way, while their edges stay crisp.
//
// How to apply it, in one rule: only to a layer that holds the BACKGROUND shapes (pill bodies,
// blobs, rounded rectangles), never to a layer with text. The threshold turns every soft edge
// into a hard one, so filtered text goes jagged and blobby. Stack the crisp content above it:
//
//   const goo = ensureGooeyFilter();            // 'url(#island-goo)'
//   <div class="shapes" style="filter: url(#island-goo)">   // or shapesLayer.style.filter = goo
//     <div class="blob"></div> <div class="blob"></div>      // opaque fills; merge when close
//   </div>
//   <div class="content">text, icons</div>                   // above the shapes, unfiltered
//
// Shapes must be opaque: with the classic 18 / -7 threshold anything below about 40% alpha
// vanishes. The filter is shared by id, so call it as often as you like.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Alpha row of the colour matrix: alpha * 18 - 7 puts the cut-off near 39%, the classic goo pairing.
const GOO_MATRIX = '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7';

/**
 * Makes sure the goo filter exists in the document and returns its CSS reference, ready for
 * `element.style.filter`. The first call for an `id` creates it (one hidden <svg> in the body);
 * later calls with that id return the reference as it is, whatever `blur` they pass, so use a
 * different id for a different blur. `blur` is the Gaussian sigma in px: how far apart shapes
 * start to bridge.
 */
export function ensureGooeyFilter(id = 'island-goo', blur = 10): string {
  const reference = `url(#${id})`;
  if (document.getElementById(id)) return reference;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Zero-sized rather than display:none, which stops some engines from resolving the filter.
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';

  // A roomy region (half the layer's size on every side) so blurred edges and necks are not cut.
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('x', '-50%');
  filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%');
  filter.setAttribute('height', '200%');
  // The matrix assumes sRGB maths; linearRGB (the default) would shift the colours and the cut-off.
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const blurred = document.createElementNS(SVG_NS, 'feGaussianBlur');
  blurred.setAttribute('in', 'SourceGraphic');
  blurred.setAttribute('stdDeviation', String(blur));
  blurred.setAttribute('result', 'blur');

  const threshold = document.createElementNS(SVG_NS, 'feColorMatrix');
  threshold.setAttribute('in', 'blur');
  threshold.setAttribute('type', 'matrix');
  threshold.setAttribute('values', GOO_MATRIX);
  threshold.setAttribute('result', 'goo');

  const paintOriginal = document.createElementNS(SVG_NS, 'feComposite');
  paintOriginal.setAttribute('in', 'SourceGraphic');
  paintOriginal.setAttribute('in2', 'goo');
  paintOriginal.setAttribute('operator', 'atop');

  filter.append(blurred, threshold, paintOriginal);
  svg.append(filter);
  (document.body ?? document.documentElement).append(svg);
  return reference;
}
