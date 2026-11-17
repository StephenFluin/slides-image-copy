/** Message shapes passed between the content script, service worker, and offscreen document. */

export type Purpose = 'copy' | 'save';

export type ImageSource =
  /** An image fetched by URL (http(s) or data:). SVGs are detected by MIME type or by sniffing. */
  | { kind: 'url'; url: string; displayWidth?: number; displayHeight?: number }
  /** Self-contained SVG markup (e.g. a serialized inline <svg> from the page). */
  | { kind: 'svg'; markup: string; displayWidth?: number; displayHeight?: number };

export interface RasterizeRequest {
  type: 'rasterize';
  source: ImageSource;
  purpose: Purpose;
}

export interface FetchRequest {
  type: 'fetch';
  url: string;
  as: 'dataUrl' | 'text';
}

export interface DownloadRequest {
  type: 'download';
  dataUrl: string;
  filename: string;
}

/** Sent from the service worker to the content script when a menu item is clicked. */
export interface MenuMessage {
  type: 'menu';
  action: Purpose;
  srcUrl?: string;
}

export type WorkerRequest = RasterizeRequest | FetchRequest | DownloadRequest;
export type OffscreenRequest = (RasterizeRequest | FetchRequest) & { target: 'offscreen' };

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type RasterizeResult = Result<{
  dataUrl: string;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  isVector: boolean;
}>;

export type FetchResult = Result<{ value: string; mime: string }>;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
