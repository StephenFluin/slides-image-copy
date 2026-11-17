// Bundles src/*.ts into dist/ and copies static/ alongside.
// Usage: node build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, watch } from 'node:fs/promises';

const isWatch = process.argv.includes('--watch');
const outdir = 'dist';

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp('static', outdir, { recursive: true });
}

await rm(outdir, { recursive: true, force: true });
await copyStatic();

const options = {
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/offscreen.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: isWatch ? 'inline' : false,
  logLevel: 'info',
};

// Content scripts can't be ES modules, so build it as an IIFE.
const contentOptions = { ...options, entryPoints: ['src/content.ts'], format: 'iife' };
const moduleOptions = { ...options, entryPoints: ['src/background.ts', 'src/offscreen.ts'] };

if (isWatch) {
  const contexts = await Promise.all([esbuild.context(moduleOptions), esbuild.context(contentOptions)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching src/ and static/ … (reload the extension in chrome://extensions after changes)');
  for await (const _ of watch('static', { recursive: true })) {
    await copyStatic();
    console.log('static/ copied');
  }
} else {
  await Promise.all([esbuild.build(moduleOptions), esbuild.build(contentOptions)]);
}
