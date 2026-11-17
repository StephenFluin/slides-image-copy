# Copy Image as PNG

A Chrome extension that lets you right-click any image on a web page and **copy it as a PNG** (or **save it as PNG/JPG**). It's built for pasting web logos into Google Slides, which won't accept SVG, WebP, or AVIF from the clipboard.

## What it handles

- `<img>` tags in any format Chrome can decode: **SVG, WebP, AVIF**, GIF, ICO, PNG, JPEG
- **Inline `<svg>` logos.** Page CSS is baked in (class-based fills, `currentColor`), and `<use>` sprite icons and gradients defined elsewhere on the page (or in an external sprite file) are pulled in.
- **CSS background images**, including `::before`/`::after`
- `<canvas>`, video posters, and images hidden under transparent overlays (it looks through the whole stack under the cursor)

## How it converts

| Source | Copy | Save |
|---|---|---|
| Vector (SVG) | PNG, rendered at 2048px on the long side (more if the SVG's native size is bigger) so logos stay crisp when resized | PNG |
| Raster with transparency | PNG at native size | PNG |
| Opaque raster | PNG at native size | **JPEG** if it's under half the PNG's size (photos), otherwise PNG (flat graphics) |

Copies are always PNG because Chrome's clipboard API only supports `image/png`. Output is capped at 4096px, and raster images are never upscaled.

## Use it

Right-click an image (or a logo that isn't technically an image) and pick **Copy Image as PNG → Copy image as PNG**. A toast confirms the copy. Then paste into Slides with Ctrl/Cmd+V.

## Develop

Requires Node 24.

```bash
npm install
npm run watch      # rebuilds dist/ on every change
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dist/` folder.
3. After a rebuild, click the reload icon on the extension's card, then reload the tab you're testing in.

Other scripts:

```bash
npm run build      # one-off production build into dist/
npm run typecheck  # tsc --noEmit
npm run check      # typecheck + build
npm run test:build # build the conversion test harness
```

### Tests

`test/index.html` runs the real conversion code (`src/convert.ts`, `src/inline-svg.ts`) against inline SVGs, sprites, SVG/WebP/AVIF sources, and format-selection cases, and checks output sizes and pixel colors. Serve the repo root over HTTP (for example `npx http-server -p 8765`), open `/test/index.html`, and click **Run tests**.

## Architecture

- `src/background.ts`: service worker. It owns the context menu, forwards conversion requests to the offscreen document, and handles downloads. On tabs opened before install, it injects the content script on demand.
- `src/content.ts`: records the right-clicked point, finds the image under it, and writes the result to the clipboard (handing `ClipboardItem` a promise so the write keeps the page's focus while conversion runs).
- `src/inline-svg.ts`: serializes an inline `<svg>` into standalone markup.
- `src/offscreen.ts` + `src/convert.ts`: an offscreen extension page that fetches images with the extension's host permissions (so page CORS and CSP don't apply) and does the canvas work.

## Known limits

- Web fonts used by `<text>` inside an SVG aren't embedded, so text falls back to system fonts. Most logos are outlined paths, so this rarely matters.
- The extension can't run on `chrome://` pages or the Chrome Web Store.
- Images behind authentication on another origin may fail if third-party cookies are blocked.
