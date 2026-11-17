/**
 * Turns an inline <svg> from the page into standalone markup that renders the same way as an image:
 * page CSS is baked into inline styles, <use>/url(#…) references to elsewhere in the page (sprites,
 * shared gradients) are copied in, and <image> hrefs are inlined as data URLs.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export type Fetcher = (url: string, as: 'dataUrl' | 'text') => Promise<string>;

/** Presentation properties whose computed values we copy onto each element. */
const STYLE_PROPS = [
  'color',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'visibility',
  'display',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'vector-effect',
  'mix-blend-mode',
  'isolation',
];

/** Elements whose content is only rendered via a reference; their computed style is out of context, so we don't bake it. */
const REFERENCED_CONTAINERS = 'defs, symbol, clipPath, mask, pattern, marker, linearGradient, radialGradient, filter';

export async function prepareInlineSvg(svg: SVGSVGElement, fetcher: Fetcher): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  bakeStyles(svg, clone);

  const rect = svg.getBoundingClientRect();
  if (!clone.getAttribute('viewBox') && rect.width && rect.height) {
    clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  }
  if (rect.width && rect.height) {
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
  }
  // Layout styles from the page (position, %, transforms) don't belong in the standalone image.
  for (const p of ['width', 'height', 'position', 'top', 'left', 'right', 'bottom', 'transform', 'margin', 'display']) {
    clone.style.removeProperty(p);
  }

  await importReferences(clone, fetcher);
  await inlineImages(clone, fetcher);

  clone.setAttribute('xmlns', SVG_NS);
  return new XMLSerializer().serializeToString(clone);
}

function bakeStyles(orig: SVGSVGElement, clone: SVGSVGElement): void {
  const origEls = [orig, ...Array.from(orig.querySelectorAll('*'))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  origEls.forEach((el, i) => {
    const target = cloneEls[i];
    if (!(el instanceof SVGElement) || !(target instanceof SVGElement)) return;
    if (el !== orig && el.closest(REFERENCED_CONTAINERS)) return;
    const cs = getComputedStyle(el);
    for (const prop of STYLE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value) target.style.setProperty(prop, localizeUrls(value));
    }
  });
}

/** Computed url() values may be absolute ("https://site/page#grad"); make them local ("#grad"). */
function localizeUrls(value: string): string {
  return value.replace(/url\(\s*["']?[^"')#]*#([^"')]+)["']?\s*\)/g, 'url("#$1")');
}

function hrefOf(el: Element): string | null {
  return el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href');
}

function setHref(el: Element, value: string): void {
  el.setAttribute('href', value);
  el.removeAttributeNS(XLINK_NS, 'href');
}

/** Copies in elements referenced by id that live outside this <svg> (icon sprites, shared defs). */
async function importReferences(clone: SVGSVGElement, fetcher: Fetcher): Promise<void> {
  const defs = document.createElementNS(SVG_NS, 'defs');
  const externalDocs = new Map<string, Promise<Document | null>>();
  const hasId = (id: string) => clone.querySelector(`[id="${CSS.escape(id)}"]`) !== null;

  // Breadth-first so imported elements' own references get resolved too.
  const queue: Element[] = [clone];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const root = queue.shift()!;
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      // <use href="#id"> and <use href="sprite.svg#id">
      const href = hrefOf(el);
      if (href && el.localName !== 'image' && el.localName !== 'a') {
        const hash = href.indexOf('#');
        if (hash >= 0) {
          const id = decodeURIComponent(href.slice(hash + 1));
          const file = href.slice(0, hash);
          if (file) setHref(el, `#${id}`);
          if (id && !hasId(id)) {
            const found = file ? await externalElement(file, id, externalDocs, fetcher) : document.getElementById(id);
            if (found) queue.push(adopt(found, defs));
          }
        }
      }
      // url(#id) in attributes and inline styles
      for (const attr of Array.from(el.attributes)) {
        for (const m of attr.value.matchAll(/url\(\s*["']?#([^"')]+)["']?\s*\)/g)) {
          const id = m[1];
          if (hasId(id)) continue;
          const found = document.getElementById(id);
          if (found) queue.push(adopt(found, defs));
        }
      }
    }
  }
  if (defs.childNodes.length) clone.insertBefore(defs, clone.firstChild);
}

function adopt(el: Element, defs: Element): Element {
  const copy = el.cloneNode(true) as Element;
  defs.append(copy);
  return copy;
}

async function externalElement(
  file: string,
  id: string,
  cache: Map<string, Promise<Document | null>>,
  fetcher: Fetcher,
): Promise<Element | null> {
  const url = new URL(file, document.baseURI).href;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetcher(url, 'text')
        .then((text) => new DOMParser().parseFromString(text, 'image/svg+xml'))
        .catch(() => null),
    );
  }
  const doc = await cache.get(url)!;
  const found = doc?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
  return found ? (document.importNode(found, true) as Element) : null;
}

async function inlineImages(clone: SVGSVGElement, fetcher: Fetcher): Promise<void> {
  const images = Array.from(clone.querySelectorAll('image'));
  await Promise.all(
    images.map(async (img) => {
      const href = hrefOf(img);
      if (!href || href.startsWith('data:')) return;
      try {
        setHref(img, await fetcher(new URL(href, document.baseURI).href, 'dataUrl'));
      } catch {
        // Leave as-is; it won't render in the copy.
      }
    }),
  );
}
