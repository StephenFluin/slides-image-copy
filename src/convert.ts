/**
 * Image conversion. Needs a DOM (Image, canvas, DOMParser), so it runs in the offscreen document.
 * Has no chrome.* dependencies so it can be exercised from a plain test page.
 */
import type { ImageSource, Purpose } from './messages';

/** Longest side we'll ever output (keeps Slides happy and memory sane). */
export const MAX_SIDE = 4096;
/** Vector images are rendered so their longest side is at least this, so logos stay crisp when scaled up in a slide. */
export const VECTOR_TARGET = 2048;
/** When saving, use JPEG only if it's at most this fraction of the PNG's size. */
export const JPEG_SIZE_RATIO = 0.5;
export const JPEG_QUALITY = 0.92;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface Converted {
  blob: Blob;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  isVector: boolean;
}

export type BlobFetcher = (url: string) => Promise<Blob>;

export async function convert(source: ImageSource, purpose: Purpose, fetchBlob: BlobFetcher): Promise<Converted> {
  let svgText: string | null = null;
  let baseUrl: string | undefined;
  let blob: Blob | null = null;

  if (source.kind === 'svg') {
    svgText = source.markup;
  } else {
    blob = await fetchBlob(source.url);
    baseUrl = source.url.startsWith('data:') ? undefined : source.url;
    if (await isSvg(blob, source.url)) svgText = await blob.text();
  }

  const canvas = svgText
    ? await rasterizeSvg(svgText, source.displayWidth, source.displayHeight, baseUrl, fetchBlob)
    : await rasterizeBitmap(blob!);

  const isVector = svgText !== null;
  const png = await toBlob(canvas, 'image/png');

  // The clipboard only accepts PNG, so "copy" is always PNG.
  if (purpose === 'copy' || isVector || hasTransparency(canvas)) {
    return { blob: png, mime: 'image/png', width: canvas.width, height: canvas.height, isVector };
  }

  // Opaque raster: pick JPEG when it's dramatically smaller (photos); flat graphics compress better as PNG anyway.
  const jpeg = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  const useJpeg = jpeg.size <= png.size * JPEG_SIZE_RATIO;
  return {
    blob: useJpeg ? jpeg : png,
    mime: useJpeg ? 'image/jpeg' : 'image/png',
    width: canvas.width,
    height: canvas.height,
    isVector,
  };
}

async function isSvg(blob: Blob, url: string): Promise<boolean> {
  if (blob.type.includes('svg')) return true;
  if (/^image\/(png|jpe?g|webp|avif|gif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(blob.type)) return false;
  if (/^data:image\/svg/i.test(url) || /\.svgz?([?#]|$)/i.test(url)) return true;
  // Servers often send SVGs as text/plain or application/octet-stream; sniff the start.
  const head = await blob.slice(0, 1024).text();
  return /<svg[\s>]/i.test(head);
}

// ---------------------------------------------------------------------------
// SVG

/** Parses an SVG length if it's absolute (unitless or px). Returns null for %, em, etc. */
function absoluteLength(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px)?\s*$/i.exec(value);
  const n = m ? parseFloat(m[1]) : NaN;
  return n > 0 ? n : null;
}

function parseViewBox(value: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return parts as [number, number, number, number];
}

/** Adds namespace declarations that inline/hand-written SVGs sometimes omit (which would otherwise fail to parse or render). */
function ensureNamespaces(text: string): string {
  return text.replace(/<svg\b([^>]*)>/i, (tag, attrs: string) => {
    let extra = '';
    if (!/\sxmlns\s*=/.test(attrs)) extra += ` xmlns="${SVG_NS}"`;
    if (/xlink:/.test(text) && !/\sxmlns:xlink\s*=/.test(attrs)) extra += ` xmlns:xlink="${XLINK_NS}"`;
    return extra ? tag.replace(/^<svg\b/i, `<svg${extra}`) : tag;
  });
}

export interface PreparedSvg {
  markup: string;
  width: number;
  height: number;
}

/**
 * Normalizes an SVG document so it renders at a known, high resolution:
 * works out its intrinsic size, guarantees a viewBox, then sets width/height to the output size.
 */
export async function prepareSvg(
  text: string,
  displayWidth?: number,
  displayHeight?: number,
  baseUrl?: string,
  fetchBlob?: BlobFetcher,
): Promise<PreparedSvg> {
  const doc = new DOMParser().parseFromString(ensureNamespaces(text), 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') {
    throw new Error('Could not parse the SVG');
  }

  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  let w = absoluteLength(root.getAttribute('width'));
  let h = absoluteLength(root.getAttribute('height'));
  const aspect = viewBox ? viewBox[2] / viewBox[3] : w && h ? w / h : displayWidth && displayHeight ? displayWidth / displayHeight : 2;

  if (!w && !h) {
    if (viewBox) [w, h] = [viewBox[2], viewBox[3]];
    else if (displayWidth && displayHeight) [w, h] = [displayWidth, displayHeight];
    else [w, h] = [300, 150]; // CSS default replaced-element size
  } else if (!w) {
    w = h! * aspect;
  } else if (!h) {
    h = w / aspect;
  }
  w = w!;
  h = h!;

  // Without a viewBox, changing width/height would crop instead of scale.
  if (!viewBox) root.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const longSide = Math.max(w, h);
  const target = Math.min(MAX_SIDE, Math.max(VECTOR_TARGET, longSide));
  const scale = target / longSide;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  root.setAttribute('width', String(outW));
  root.setAttribute('height', String(outH));
  // CSS sizing on the root would override the attributes.
  if (root instanceof SVGElement) {
    root.style.removeProperty('width');
    root.style.removeProperty('height');
  }

  // SVGs rendered as images can't load external resources, so inline any <image> hrefs.
  if (fetchBlob) await inlineImages(doc, baseUrl, fetchBlob);

  return { markup: new XMLSerializer().serializeToString(doc), width: outW, height: outH };
}

async function inlineImages(doc: Document, baseUrl: string | undefined, fetchBlob: BlobFetcher): Promise<void> {
  const images = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'image'));
  await Promise.all(
    images.map(async (img) => {
      const href = img.getAttribute('href') ?? img.getAttributeNS(XLINK_NS, 'href');
      if (!href || href.startsWith('data:')) return;
      try {
        const abs = new URL(href, baseUrl).href;
        const dataUrl = await blobToDataUrl(await fetchBlob(abs));
        img.setAttribute('href', dataUrl);
        img.removeAttributeNS(XLINK_NS, 'href');
      } catch {
        // Leave it; it just won't render.
      }
    }),
  );
}

async function rasterizeSvg(
  text: string,
  displayWidth: number | undefined,
  displayHeight: number | undefined,
  baseUrl: string | undefined,
  fetchBlob: BlobFetcher,
): Promise<HTMLCanvasElement> {
  const svg = await prepareSvg(text, displayWidth, displayHeight, baseUrl, fetchBlob);
  const img = await loadImage(new Blob([svg.markup], { type: 'image/svg+xml' }));
  const canvas = makeCanvas(svg.width, svg.height);
  canvas.getContext('2d')!.drawImage(img, 0, 0, svg.width, svg.height);
  return canvas;
}

// ---------------------------------------------------------------------------
// Raster

async function rasterizeBitmap(blob: Blob): Promise<HTMLCanvasElement> {
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  try {
    const bmp = await createImageBitmap(blob);
    [source, w, h] = [bmp, bmp.width, bmp.height];
  } catch {
    // Some formats (e.g. .ico) only decode via <img>.
    const img = await loadImage(blob);
    [source, w, h] = [img, img.naturalWidth, img.naturalHeight];
  }
  if (!w || !h) throw new Error('Image has no size');

  const scale = Math.min(1, MAX_SIDE / Math.max(w, h)); // never upscale bitmaps
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const canvas = makeCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, outW, outH);
  if (source instanceof ImageBitmap) source.close();
  return canvas;
}

// ---------------------------------------------------------------------------
// Helpers

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not decode this image'));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality),
  );
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
