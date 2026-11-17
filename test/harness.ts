/**
 * Browser test harness for the conversion pipeline (no extension APIs needed).
 * Build with `npm run test:build`, then open test/index.html and call `await runTests()`.
 */
import { convert, type BlobFetcher } from '../src/convert';
import { prepareInlineSvg } from '../src/inline-svg';
import type { ImageSource, Purpose } from '../src/messages';

const fetchBlob: BlobFetcher = async (url) => (await fetch(url)).blob();
const fetchFor = async (url: string, as: 'dataUrl' | 'text') => {
  const blob = await fetchBlob(url);
  if (as === 'text') return blob.text();
  return new Promise<string>((r) => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result as string);
    fr.readAsDataURL(blob);
  });
};

interface Case {
  name: string;
  source: () => Promise<ImageSource>;
  purpose: Purpose;
  /** [x fraction, y fraction, expected rgba] */
  probe?: [number, number, [number, number, number, number]];
  expect: { mime?: string; minSide?: number; aspect?: number };
}

const inline = (id: string) => async (): Promise<ImageSource> => {
  const svg = document.getElementById(id) as unknown as SVGSVGElement;
  const r = svg.getBoundingClientRect();
  return { kind: 'svg', markup: await prepareInlineSvg(svg, fetchFor), displayWidth: r.width, displayHeight: r.height };
};
const url = (u: string) => async (): Promise<ImageSource> => ({ kind: 'url', url: u });
const svgData = (s: string) => 'data:image/svg+xml,' + encodeURIComponent(s);

function noiseWebp(): string {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(400, 300);
  for (let i = 0; i < img.data.length; i += 4) {
    const x = (i / 4) % 400;
    img.data[i] = (x + Math.random() * 60) % 256;
    img.data[i + 1] = Math.random() * 255;
    img.data[i + 2] = 128;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/webp', 0.9);
}

function flatWebp(): string {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 100;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 200, 100);
  ctx.fillStyle = '#1a73e8';
  ctx.fillRect(20, 20, 160, 60);
  return c.toDataURL('image/webp', 1);
}

const PINK: [number, number, number, number] = [233, 30, 99, 255];
const BLUE: [number, number, number, number] = [26, 115, 232, 255];

const cases: Case[] = [
  { name: 'inline svg, page CSS class fill', source: inline('css-class'), purpose: 'copy', probe: [0.5, 0.5, PINK], expect: { mime: 'image/png', minSide: 2048, aspect: 2 } },
  { name: 'inline svg, currentColor', source: inline('current-color'), purpose: 'copy', probe: [0.5, 0.5, BLUE], expect: { mime: 'image/png', minSide: 2048, aspect: 1 } },
  { name: 'inline svg, <use> sprite from elsewhere in page', source: inline('sprite-use'), purpose: 'copy', probe: [0.5, 0.5, PINK], expect: { mime: 'image/png', minSide: 2048 } },
  { name: 'inline svg, gradient defined in another svg', source: inline('ext-gradient'), purpose: 'copy', probe: [0.002, 0.5, [255, 0, 0, 255]], expect: { mime: 'image/png' } },
  { name: 'svg url, viewBox only', source: url(svgData('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#e91e63"/></svg>')), purpose: 'save', probe: [0.5, 0.5, PINK], expect: { mime: 'image/png', minSide: 2048, aspect: 4 } },
  { name: 'svg url, width/height only (no viewBox)', source: url(svgData('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="60"><rect width="30" height="60" fill="#1a73e8"/></svg>')), purpose: 'copy', probe: [0.9, 0.9, BLUE], expect: { aspect: 0.5, minSide: 2048 } },
  { name: 'svg url, no xmlns, served as text/plain', source: url('data:text/plain,' + encodeURIComponent('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#e91e63"/></svg>')), purpose: 'copy', probe: [0.5, 0.5, PINK], expect: { mime: 'image/png' } },
  { name: 'svg url, transparent corners stay transparent', source: url(svgData('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#000"/></svg>')), purpose: 'save', probe: [0.01, 0.01, [0, 0, 0, 0]], expect: { mime: 'image/png' } },
  { name: 'photo-like webp → save picks JPEG', source: async () => ({ kind: 'url', url: noiseWebp() }), purpose: 'save', expect: { mime: 'image/jpeg' } },
  { name: 'photo-like webp → copy is PNG', source: async () => ({ kind: 'url', url: noiseWebp() }), purpose: 'copy', expect: { mime: 'image/png' } },
  { name: 'flat webp → save picks PNG, no upscale', source: async () => ({ kind: 'url', url: flatWebp() }), purpose: 'save', probe: [0.5, 0.5, BLUE], expect: { mime: 'image/png', aspect: 2 } },
  { name: 'avif → PNG', source: async () => ({ kind: 'url', url: await fetchFor(new URL('sample.avif', location.href).href, 'dataUrl') }), purpose: 'copy', expect: { mime: 'image/png', aspect: 64 / 40 } },
];

async function probe(blob: Blob, fx: number, fy: number): Promise<number[]> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return Array.from(ctx.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data);
}

async function runTests() {
  const out = document.getElementById('results')!;
  out.textContent = '';
  const results = [];
  for (const c of cases) {
    const problems: string[] = [];
    let summary = '';
    try {
      const r = await convert(await c.source(), c.purpose, fetchBlob);
      summary = `${r.mime} ${r.width}×${r.height} ${(r.blob.size / 1024).toFixed(1)}KB`;
      if (c.expect.mime && r.mime !== c.expect.mime) problems.push(`mime ${r.mime}`);
      if (c.expect.minSide && Math.max(r.width, r.height) < c.expect.minSide) problems.push('too small');
      if (c.expect.aspect && Math.abs(r.width / r.height - c.expect.aspect) > 0.02) problems.push(`aspect ${(r.width / r.height).toFixed(3)}`);
      if (c.probe) {
        const px = await probe(r.blob, c.probe[0], c.probe[1]);
        if (px.some((v, i) => Math.abs(v - c.probe![2][i]) > 6)) problems.push(`pixel ${px} ≠ ${c.probe[2]}`);
      }
      const img = document.createElement('img');
      img.src = URL.createObjectURL(r.blob);
      img.style.cssText = 'height:48px;border:1px dashed #999;margin-right:8px;vertical-align:middle;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0/12px 12px';
      out.append(img);
    } catch (e) {
      problems.push(String(e));
    }
    const line = document.createElement('div');
    line.textContent = `${problems.length ? '✗' : '✓'} ${c.name} — ${summary} ${problems.join('; ')}`;
    out.append(line);
    results.push({ name: c.name, pass: !problems.length, summary, problems });
  }
  return results;
}

Object.assign(window, { runTests });
