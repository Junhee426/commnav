// No bundler is needed: dist contains the application source and public assets.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const required = [
  'index.html', 'styles.css', 'app.js', 'engine.js',
  'analysis-worker.js', 'rendering.js', 'earth.jpg',
];

async function checkFile(path) {
  const info = await stat(path);
  assert(info.isFile() && info.size > 0, `Missing or empty file: ${path}`);
}

for (const name of required) await checkFile(resolve(root, name));

let checkedReferences = 0;
for (const name of await readdir(root)) {
  if (!['.html', '.css', '.js'].includes(extname(name))) continue;
  const path = resolve(root, name);
  const source = await readFile(path, 'utf8');
  if (name.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || `Invalid JavaScript: ${name}`);
  }

  // Validate the literal relative paths used by this static application,
  // including ES imports, the module Worker, and the local Earth texture.
  for (const match of source.matchAll(/["'](\.\.?\/[^"'\s]+)["']/g)) {
    const reference = match[1].split(/[?#]/)[0];
    const target = resolve(dirname(path), reference);
    assert(target.startsWith(root.endsWith(sep) ? root : root + sep),
      `Reference leaves the publish directory: ${name} -> ${reference}`);
    await checkFile(target);
    checkedReferences++;
  }
}

console.log(`Static assets ready: ${required.length} required files, ${checkedReferences} local references verified.`);
