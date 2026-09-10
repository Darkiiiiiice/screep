/**
 * Build the Screeps upload artifact.
 *
 * The official server runs Node 24 and loads modules the CommonJS way
 * (`require` / `module.exports`), so we author ESM + TypeScript and bundle to a
 * single CJS file whose `exports.loop` is the tick entrypoint.
 *
 * When the runtime gains native ESM + folder-module support (on the 2026
 * roadmap), drop the bundling step and upload the output directory instead —
 * the source does not have to change.
 *
 * Usage:
 *   node scripts/build.mjs [--dev] [--out dist/main.js]
 *
 *   --dev  inline sourcemaps + no minify, so live stack traces stay readable.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const outFlag = args.indexOf('--out');
const outFile = resolve(
  process.cwd(),
  outFlag !== -1 ? args[outFlag + 1] : 'dist/main.js',
);

mkdirSync(dirname(outFile), { recursive: true });

const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  // Match the official runtime. Target node24 so we never emit syntax the
  // server cannot parse; ES2022 features are safe.
  target: ['node24'],
  // The engine globals (Game, Memory, Creep, ...) only exist inside the game
  // VM. Marking them external is what keeps them as bare identifiers.
  external: ['lodash'],
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const bytes = statSync(outFile).size;

// The package is "type": "module", so a bare .js file here would be parsed as
// ESM by Node — `module.exports` would be ignored and the artifact would look
// like it exports nothing. Mark the output directory as CommonJS so the
// conventional `main.js` name stays correct for the Screeps upload.
writeFileSync(
  `${dirname(outFile)}/package.json`,
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);

// Verify the one contract the server depends on by actually loading the bundle,
// rather than pattern-matching the minified text.
const loaded = createRequire(import.meta.url)(outFile);
if (typeof loaded.loop !== 'function') {
  console.error(
    `[build] ${outFile} does not export a callable 'loop' entrypoint (got ${typeof loaded.loop}).`,
  );
  process.exit(1);
}

writeFileSync(
  `${outFile}.meta.json`,
  `${JSON.stringify({ bytes, dev: isDev, target: 'node24', at: new Date().toISOString() }, null, 2)}\n`,
);

console.log(
  `[build] ${outFile}  ${(bytes / 1024).toFixed(1)} KiB  ${isDev ? '(dev, inline sourcemap)' : '(minified)'}`,
);
console.log(
  `[build] 'loop' export verified by loading the bundle; ${Object.keys(result.metafile.inputs).length} input modules bundled`,
);
