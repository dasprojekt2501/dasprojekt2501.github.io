import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = resolve(root, 'apps/vendor');
const pdfjsSource = resolve(root, 'node_modules/pdfjs-dist');
const pdfLibSource = resolve(root, 'node_modules/pdf-lib');

await rm(resolve(vendorRoot, 'pdfjs'), { recursive: true, force: true });
await rm(resolve(vendorRoot, 'pdf-lib'), { recursive: true, force: true });
await mkdir(resolve(vendorRoot, 'pdfjs'), { recursive: true });
await mkdir(resolve(vendorRoot, 'pdf-lib'), { recursive: true });

for (const [from, to] of [
  ['build/pdf.mjs', 'pdfjs/pdf.mjs'],
  ['build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs'],
  ['LICENSE', 'pdfjs/LICENSE'],
  ['dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js'],
  ['LICENSE.md', 'pdf-lib/LICENSE.md'],
]) {
  await cp(resolve(from.startsWith('build/') || from === 'LICENSE' ? pdfjsSource : pdfLibSource, from), resolve(vendorRoot, to));
}

for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(resolve(pdfjsSource, directory), resolve(vendorRoot, 'pdfjs', directory), { recursive: true });
}

console.log('PDF Toolkit vendor assets are synchronized.');
