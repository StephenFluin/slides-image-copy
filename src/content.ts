/**
 * Content script: remembers what was right-clicked, works out which image that is
 * (<img>, inline <svg>, <canvas>, or CSS background), and writes the result to the clipboard.
 */
import { prepareInlineSvg } from './inline-svg';
import { errorMessage, type FetchResult, type ImageSource, type MenuMessage, type Purpose, type RasterizeResult } from './messages';
import { toast } from './toast';

interface Found {
  source: ImageSource;
  /** Base filename (no extension) for saving. */
  name: string;
}

declare global {
  interface Window {
    __slidesImageCopy?: boolean;
  }
}

if (!window.__slidesImageCopy) {
  window.__slidesImageCopy = true;

  let lastClick: { x: number; y: number; path: EventTarget[] } | null = null;

  document.addEventListener(
    'contextmenu',
    (e) => {
      lastClick = { x: e.clientX, y: e.clientY, path: e.composedPath() };
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg: MenuMessage, _sender, sendResponse) => {
    if (msg?.type !== 'menu') return false;
    sendResponse({ ok: true }); // ack right away; the work continues below
    const found = findImage(lastClick, msg.srcUrl);
    lastClick = null;
    void run(msg.action, found);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Finding the image under the cursor

function findImage(click: { x: number; y: number; path: EventTarget[] } | null, srcUrl?: string): Promise<Found> | null {
  const candidates: Element[] = [];
  if (click) {
    for (const t of click.path) if (t instanceof Element) candidates.push(t);
    for (const el of document.elementsFromPoint(click.x, click.y)) if (!candidates.includes(el)) candidates.push(el);
  }

  // Pass 1: real image elements anywhere in the stack under the cursor (they're often under transparent overlays).
  for (const el of candidates) {
    const found = fromElement(el);
    if (found) return found;
  }
  // Pass 2: CSS background images, nearest first.
  for (const el of candidates) {
    const url = backgroundUrl(el);
    if (url) return fromUrl(url, el);
  }
  if (srcUrl) return fromUrl(srcUrl, null);
  return null;
}

function fromElement(el: Element): Promise<Found> | null {
  if (el instanceof HTMLImageElement && (el.currentSrc || el.src)) {
    return fromUrl(el.currentSrc || el.src, el);
  }
  if (el instanceof SVGElement) {
    let svg: SVGSVGElement | null = el instanceof SVGSVGElement ? el : el.ownerSVGElement;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    if (svg) {
      const rect = svg.getBoundingClientRect();
      return prepareInlineSvg(svg, fetchViaWorker).then((markup) => ({
        source: { kind: 'svg', markup, displayWidth: rect.width, displayHeight: rect.height },
        name: nameForElement(svg) ?? 'logo',
      }));
    }
  }
  if (el instanceof HTMLCanvasElement) {
    try {
      return fromUrl(el.toDataURL('image/png'), el);
    } catch {
      return null; // tainted canvas
    }
  }
  if (el instanceof HTMLVideoElement && el.poster) return fromUrl(el.poster, el);
  if (el instanceof HTMLInputElement && el.type === 'image' && el.src) return fromUrl(el.src, el);
  return null;
}

function backgroundUrl(el: Element): string | null {
  for (const pseudo of [null, '::before', '::after']) {
    const style = getComputedStyle(el, pseudo);
    for (const value of [style.backgroundImage, pseudo ? style.content : 'none']) {
      const m = /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value);
      if (m?.[2]) return m[2];
    }
  }
  return null;
}

async function fromUrl(url: string, el: Element | null): Promise<Found> {
  const abs = new URL(url, document.baseURI).href;
  const rect = el?.getBoundingClientRect();
  let finalUrl = abs;
  // blob: URLs belong to the page's origin, so read them here rather than in the extension.
  if (abs.startsWith('blob:')) {
    const blob = await (await fetch(abs)).blob();
    finalUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  return {
    source: { kind: 'url', url: finalUrl, displayWidth: rect?.width, displayHeight: rect?.height },
    name: nameForUrl(abs) ?? (el && nameForElement(el)) ?? `${location.hostname}-image`,
  };
}

function nameForUrl(url: string): string | null {
  if (url.startsWith('data:') || url.startsWith('blob:')) return null;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '') : null;
  } catch {
    return null;
  }
}

function nameForElement(el: Element): string | null {
  const title = el.querySelector(':scope > title')?.textContent;
  return el.getAttribute('aria-label') || el.getAttribute('alt') || title || el.id || null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'image';
}

// ---------------------------------------------------------------------------
// Talking to the service worker

async function fetchViaWorker(url: string, as: 'dataUrl' | 'text'): Promise<string> {
  const res: FetchResult = await chrome.runtime.sendMessage({ type: 'fetch', url, as });
  if (!res?.ok) throw new Error(res?.error ?? 'Fetch failed');
  return res.value;
}

async function rasterize(source: ImageSource, purpose: Purpose): Promise<Extract<RasterizeResult, { ok: true }>> {
  const res: RasterizeResult = await chrome.runtime.sendMessage({ type: 'rasterize', source, purpose });
  if (!res) throw new Error('No response from the extension (try reloading the page)');
  if (!res.ok) throw new Error(res.error);
  return res;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

// ---------------------------------------------------------------------------
// Actions

async function run(action: Purpose, found: Promise<Found> | null): Promise<void> {
  if (!found) {
    toast('No image found where you right-clicked', 'error');
    return;
  }
  toast('Converting…', 'busy');
  if (action === 'copy') await copy(found);
  else await save(found);
}

async function copy(found: Promise<Found>): Promise<void> {
  let info = '';
  // Hand the clipboard a promise immediately, so the write is tied to this moment of focus
  // even though conversion takes a little while.
  const png = found
    .then((f) => rasterize(f.source, 'copy'))
    .then((r) => {
      info = `${r.width}×${r.height}`;
      return dataUrlToBlob(r.dataUrl);
    });
  png.catch(() => {}); // handled below

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(`Copied ${info} PNG`, 'ok');
    return;
  } catch (e) {
    // Conversion failure vs. clipboard failure?
    const conversionError = await png.then(
      () => null,
      (err: unknown) => err,
    );
    if (conversionError) {
      toast(`Couldn't convert image: ${errorMessage(conversionError)}`, 'error');
      return;
    }
    // Usually "Document is not focused" (e.g. DevTools had focus). Try once more with the finished blob.
    try {
      window.focus();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
      toast(`Copied ${info} PNG`, 'ok');
    } catch {
      toast(`Couldn't write to the clipboard (${errorMessage(e)}). Click the page and try again.`, 'error');
    }
  }
}

async function save(found: Promise<Found>): Promise<void> {
  try {
    const f = await found;
    const r = await rasterize(f.source, 'save');
    const ext = r.mime === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `${sanitizeFilename(f.name)}.${ext}`;
    const res: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({ type: 'download', dataUrl: r.dataUrl, filename });
    if (!res?.ok) throw new Error(res?.error ?? 'Download failed');
    toast(`Saved ${filename} (${r.width}×${r.height})`, 'ok');
  } catch (e) {
    toast(`Couldn't save image: ${errorMessage(e)}`, 'error');
  }
}
