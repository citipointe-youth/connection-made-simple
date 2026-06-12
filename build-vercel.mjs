// Vercel Build Output API v3 build script.
// Bundles the Express app into a single CJS file so @vercel/node transpile
// mode (which leaves extensionless ESM imports unresolved) is bypassed entirely.
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const FUNC_DIR = '.vercel/output/functions/api/index.func';
const STATIC_DIR = '.vercel/output/static';

mkdirSync(FUNC_DIR, { recursive: true });
mkdirSync(STATIC_DIR, { recursive: true });

// Bundle api/index.ts + all src/ imports into one self-contained CJS file.
await esbuild.build({
  entryPoints: ['api/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: `${FUNC_DIR}/index.js`,
});

writeFileSync(`${FUNC_DIR}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs20.x',
  handler: 'index.js',
  launcherType: 'Nodejs'
}));

writeFileSync('.vercel/output/config.json', JSON.stringify({
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/api/index' }
  ]
}));

function copyDir(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
copyDir('public', STATIC_DIR);

console.log('Vercel build complete.');
