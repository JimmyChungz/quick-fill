import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

// Chrome loads dist/. Build only into disposable output; never clean the live runtime.
const OUTPUT = '.build/extension';
const entries = [
  ['src/background/service-worker.ts', 'background'],
  ['src/content/index.ts', 'content'],
  ['src/popup/popup.ts', 'popup'],
  ['src/options/options.ts', 'options'],
  ['src/options/diagnostics.ts', 'diagnostics'],
  ['src/unlock/unlock.ts', 'unlock'],
];

const base = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
};

const isWatch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production' && !isWatch;
base.sourcemap = !isProd;

async function copyStatic() {
  await cp('public', OUTPUT, { recursive: true });
  if (isProd) await rm(`${OUTPUT}/qf-test.html`, { force: true });
  await cp('manifest.json', `${OUTPUT}/manifest.json`);
  await cp('LICENSE', `${OUTPUT}/LICENSE`);
}

async function cleanDist() {
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
}

if (isWatch) {
  await cleanDist();
  const ctxs = await Promise.all(
    entries.map(([in_, out]) =>
      esbuild.context({
        ...base,
        entryPoints: [in_],
        outfile: `${OUTPUT}/${out}.js`,
        minify: false,
      }),
    ),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  await copyStatic();
  console.log('[qf] watching...');
} else {
  await cleanDist();
  const results = await Promise.all(
    entries.map(([in_, out]) =>
      esbuild.build({
        ...base,
        entryPoints: [in_],
        outfile: `${OUTPUT}/${out}.js`,
        minify: isProd,
      }),
    ),
  );
  // "build OK" used to mean "no errors" — a duplicated `case` label shipped in
  // background.js for a while because esbuild only warned about it. Treat
  // warnings as failures so they cannot be skimmed past again.
  const warnings = results.flatMap((r) => r.warnings);
  if (warnings.length > 0) {
    console.error(`[qf] build FAILED: ${warnings.length} warning(s)`);
    for (const w of warnings) {
      const where = w.location
        ? ` (${w.location.file}:${w.location.line})`
        : '';
      console.error(`  [${w.id ?? 'warning'}] ${w.text}${where}`);
    }
    process.exit(1);
  }
  await copyStatic();
  console.log('[qf] build done (0 warnings)');
}
