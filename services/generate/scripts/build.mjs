// Bundles each Lambda handler to dist/<name>/index.mjs with esbuild.
// Terraform's archive_file zips each dist/<name> directory.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handlersDir = join(root, 'src', 'handlers');
const distDir = join(root, 'dist');

// Handlers that read fixture files at runtime get them copied alongside.
const FIXTURE_HANDLERS = new Set(['inference-stub', 'postprocess-lite']);

await rm(distDir, { recursive: true, force: true });

const entries = (await readdir(handlersDir)).filter((f) => f.endsWith('.ts'));

for (const entry of entries) {
  const name = entry.replace(/\.ts$/, '');
  const outDir = join(distDir, name);
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [join(handlersDir, entry)],
    outfile: join(outDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: false,
    minify: false,
    // node: prefixed built-ins resolve at runtime; bundle everything else
    // (including the AWS SDK) for hermetic artifacts.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });

  if (FIXTURE_HANDLERS.has(name)) {
    await cp(join(root, 'fixtures'), join(outDir, 'fixtures'), { recursive: true });
  }

  console.log(`built ${name}`);
}
