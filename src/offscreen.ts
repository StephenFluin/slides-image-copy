/**
 * Offscreen document: an extension page with a DOM and host permissions, so it can fetch
 * cross-origin images and decode SVGs without being subject to the page's CSP.
 */
import { blobToDataUrl, convert } from './convert';
import { errorMessage, type FetchResult, type OffscreenRequest, type RasterizeResult } from './messages';

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  return res.blob();
}

async function handle(msg: OffscreenRequest): Promise<RasterizeResult | FetchResult> {
  try {
    if (msg.type === 'rasterize') {
      const out = await convert(msg.source, msg.purpose, fetchBlob);
      return {
        ok: true,
        dataUrl: await blobToDataUrl(out.blob),
        mime: out.mime,
        width: out.width,
        height: out.height,
        isVector: out.isVector,
      };
    }
    const blob = await fetchBlob(msg.url);
    return {
      ok: true,
      value: msg.as === 'text' ? await blob.text() : await blobToDataUrl(blob),
      mime: blob.type,
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then(sendResponse);
  return true; // async response
});
