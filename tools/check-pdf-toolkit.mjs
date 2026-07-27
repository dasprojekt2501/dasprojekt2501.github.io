import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  ja: resolve(root, 'apps/pdf-toolkit.html'),
  en: resolve(root, 'apps/pdf-toolkit-en.html'),
  css: resolve(root, 'apps/pdf-toolkit.css'),
  js: resolve(root, 'apps/pdf-toolkit.js'),
};
const sources = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const syntax = spawnSync(process.execPath, ['--check', paths.js], { encoding: 'utf8' });
check(syntax.status === 0, `JavaScript syntax check failed: ${syntax.stderr.trim()}`);

for (const language of ['ja', 'en']) {
  const html = sources[language];
  check(/Content-Security-Policy/.test(html), `${language}: CSP meta tag is missing.`);
  check(/script-src 'self'/.test(html), `${language}: scripts are not restricted to self.`);
  check(/object-src 'none'/.test(html), `${language}: object embedding is not disabled.`);
  check(/<script type="module" src="pdf-toolkit\.js"><\/script>/.test(html), `${language}: the shared module script is missing.`);
  check(!/\son(?:click|input|change|load|error)\s*=/i.test(html), `${language}: inline event handlers are not allowed.`);
  check(!/<script(?![^>]+\bsrc=)[^>]*>/i.test(html), `${language}: inline scripts are not allowed.`);
  check(!/https?:\/\//i.test(html), `${language}: remote application dependencies are not allowed.`);
}

check(!/@import|https?:\/\//i.test(sources.css), 'CSS contains a remote import or URL.');
check(!/pdfjsLib|cdnjs|unpkg|jsdelivr/i.test(sources.js), 'JavaScript contains a legacy PDF.js global or CDN reference.');
check(/isEvalSupported:\s*false/.test(sources.js), 'PDF.js JavaScript evaluation is not disabled.');
check(/maxFileBytes:\s*100\s*\*\s*1024\s*\*\s*1024/.test(sources.js), 'The 100 MB file limit is missing.');
check(/maxPages:\s*500/.test(sources.js), 'The 500-page limit is missing.');
check(/marginPt\s*\/\s*displaySize\.width/.test(sources.js), 'Trim margin is not applied to output geometry.');
check(/new URL\('\.\/vendor\/pdfjs\//.test(sources.js), 'PDF.js is not loaded from the local vendor directory.');

const ids = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).filter(id => id !== 'favicon'));
const jaIds = ids(sources.ja);
const enIds = ids(sources.en);
check([...jaIds].every(id => enIds.has(id)) && [...enIds].every(id => jaIds.has(id)), 'Japanese and English pages have different element IDs.');

for (const relativePath of [
  'apps/vendor/pdfjs/pdf.mjs',
  'apps/vendor/pdfjs/pdf.worker.mjs',
  'apps/vendor/pdfjs/LICENSE',
  'apps/vendor/pdf-lib/pdf-lib.esm.min.js',
  'apps/vendor/pdf-lib/LICENSE.md',
]) {
  const path = resolve(root, relativePath);
  try {
    await access(path, constants.R_OK);
    check((await stat(path)).size > 0, `${relativePath} is empty.`);
  } catch {
    failures.push(`${relativePath} is missing.`);
  }
}

for (const introFile of ['apps/pdf-toolkit-intro.html', 'apps/pdf-toolkit-intro-en.html']) {
  const intro = await readFile(resolve(root, introFile), 'utf8');
  check(/Content-Security-Policy/.test(intro), `${introFile}: CSP meta tag is missing.`);
  check(!/\son(?:click|input|change|load|error)\s*=/i.test(intro), `${introFile}: inline event handlers are not allowed.`);
  check(!/<script(?![^>]+\bsrc=)[^>]*>/i.test(intro), `${introFile}: inline scripts are not allowed.`);
  check(!/download="pdf-toolkit/i.test(intro), `${introFile}: obsolete standalone HTML download is still advertised.`);
  for (const match of intro.matchAll(/<a[^>]+target="_blank"[^>]*>/gi)) {
    check(/\brel="[^"]*noopener[^"]*"/i.test(match[0]), `${introFile}: target=_blank link is missing rel=noopener.`);
  }
}

if (failures.length) {
  console.error(`PDF Toolkit checks failed (${failures.length}):`);
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('PDF Toolkit security and consistency checks passed.');
