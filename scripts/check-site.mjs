import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const htmlFiles = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.name.endsWith('.html')) htmlFiles.push(target);
  }
}

await walk(output);
const missing = [];
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const reference = match[1];
    if (/^(?:https?:|mailto:|data:|#)/.test(reference)) continue;
    const clean = reference.split('#')[0].split('?')[0];
    if (!clean) continue;
    let target = path.resolve(path.dirname(file), clean);
    if (clean.endsWith('/')) target = path.join(target, 'index.html');
    try { await access(target); }
    catch { missing.push(`${path.relative(output, file)} → ${reference}`); }
  }
}

for (const required of [
  'index.html',
  'spec/index.html',
  'conformance/index.html',
  'libraries/index.html',
  'workbench/index.html',
  'workbench/node_modules/opalinx/src/index.js',
  'workbench/node_modules/djipevents/dist/esm/djipevents.esm.min.js',
]) {
  try { await access(path.join(output, required)); }
  catch { missing.push(required); }
}

if (missing.length) throw new Error(`Missing site targets:\n${missing.join('\n')}`);
console.log(`Validated ${htmlFiles.length} HTML pages and all local asset references`);
