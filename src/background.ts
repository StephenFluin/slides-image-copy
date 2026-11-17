/** Service worker: owns the context menu, the offscreen converter, and downloads. */
import type { MenuMessage, OffscreenRequest, Purpose, WorkerRequest } from './messages';

const MENU: Record<Purpose, string> = {
  copy: 'Copy image as PNG',
  save: 'Save image as PNG/JPG',
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of Object.entries(MENU)) {
      // 'all' so it also appears on inline SVGs and CSS background images, which aren't "image" contexts.
      chrome.contextMenus.create({ id, title, contexts: ['all'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !(info.menuItemId in MENU)) return;
  const frameId = info.frameId ?? 0;
  const msg: MenuMessage = { type: 'menu', action: info.menuItemId as Purpose, srcUrl: info.srcUrl };
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId });
  } catch {
    // Tab was open before the extension was installed/reloaded: inject the content script and retry.
    // (It missed the right-click, so it falls back to info.srcUrl.)
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, msg, { frameId });
    } catch (e) {
      console.warn('Cannot run on this page', e); // e.g. chrome:// pages or the Web Store
    }
  }
});

// ---------------------------------------------------------------------------
// Offscreen document

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url,
      reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS],
      justification: 'Decode SVG/WebP/AVIF images and re-encode them as PNG/JPG.',
    })
    .finally(() => (creating = null));
  await creating;
}

async function toOffscreen(msg: Exclude<WorkerRequest, { type: 'download' }>): Promise<unknown> {
  await ensureOffscreen();
  const forwarded: OffscreenRequest = { ...msg, target: 'offscreen' };
  return chrome.runtime.sendMessage(forwarded);
}

chrome.runtime.onMessage.addListener((msg: WorkerRequest & { target?: string }, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  switch (msg?.type) {
    case 'rasterize':
    case 'fetch':
      toOffscreen(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'download':
      chrome.downloads
        .download({ url: msg.dataUrl, filename: msg.filename, conflictAction: 'uniquify' })
        .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
  }
  return false;
});
