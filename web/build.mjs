#!/usr/bin/env node
// Build the WAO console into web/dist (DESIGN §9): esbuild bundles
// src/shell.jsx (+ sdk.js) with JSX factory h — React itself is NOT bundled;
// index.html loads the single vendored UMD instance shared by shell and page
// plugins. dist/ is committed: runtime and tests never need this script; it
// exists to rebuild after editing web/src.
//
//   node web/build.mjs
//
// Re-vendoring React (rare, pin-bump only): the pinned devDeps are the
// source — copy node_modules/{react,react-dom}/umd/*.production.min.js into
// web/vendor/ with the provenance header (see web/vendor/*.umd.js), then
// rebuild.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)));
const dist = join(webDir, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'assets'), { recursive: true });

await build({
  entryPoints: [join(webDir, 'src', 'shell.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  outfile: join(dist, 'assets', 'app.js'),
  // Non-literal dynamic import(entry) stays a runtime import() — the page
  // modules are served by the kernel, not bundled.
  logLevel: 'info',
  target: ['es2022'],
});

// Self-contained dist: stylesheet, hand-written index.html, the vendored
// React UMD (served at /vendor/*), and the shared harness stub (served at
// /assets/harness-lib/* so every plugin's harness.html can import it
// same-origin without escaping its own /api/ui/<id>/ root).
cpSync(join(webDir, 'src', 'styles.css'), join(dist, 'assets', 'app.css'));
cpSync(join(webDir, 'index.html'), join(dist, 'index.html'));
mkdirSync(join(dist, 'vendor'), { recursive: true });
cpSync(join(webDir, 'vendor'), join(dist, 'vendor'), { recursive: true });
mkdirSync(join(dist, 'assets', 'harness-lib'), { recursive: true });
cpSync(join(webDir, 'harness-lib'), join(dist, 'assets', 'harness-lib'), { recursive: true });
try { cpSync(join(webDir, 'assets'), join(dist, 'assets'), { recursive: true }); } catch {}

// 「头像即化身」(redesign P1): bundle the DiceBear avatar into an ESM lib the
// harness stub imports same-origin (./avatar-lib.js), so harness screenshots
// show the same faces production does — fully offline, no CDN.
await build({
  entryPoints: [join(webDir, 'src', 'avatar.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  outfile: join(dist, 'assets', 'harness-lib', 'avatar-lib.js'),
  logLevel: 'info',
  target: ['es2022'],
});

console.log('web: built dist (app.js + avatar-lib.js + app.css + index.html + vendor + harness-lib)');
