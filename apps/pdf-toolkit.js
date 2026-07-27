import { GlobalWorkerOptions, getDocument } from './vendor/pdfjs/pdf.mjs';
import { PDFDocument, degrees } from './vendor/pdf-lib/pdf-lib.esm.min.js';

if (window.top !== window.self) {
  document.body.replaceChildren();
  const warning = document.createElement('p');
  warning.className = 'security-notice';
  warning.textContent = document.documentElement.lang.startsWith('en')
    ? 'For your security, PDF Toolkit cannot run inside another website.'
    : '安全のため、PDF Toolkitは他のサイト内に埋め込んだ状態では実行できません。';
  document.body.appendChild(warning);
  throw new Error('PDF Toolkit refused to run in a frame.');
}

const isEnglish = document.documentElement.lang.startsWith('en');
const msg = (ja, en) => isEnglish ? en : ja;
const LIMITS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxPages: 500,
  maxCanvasPixels: 25_000_000,
  maxTotalCanvasPixels: 120_000_000,
});
const PDFJS_ROOT = new URL('./vendor/pdfjs/', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', PDFJS_ROOT).href;

function drawPdfIcon(canvas){
  var s=canvas.width,c=canvas,x=c.getContext('2d');
  var r=5, bx=8, by=2, bw=48, bh=60, fold=14;
  var sc=s/64;
  x.save();x.scale(sc,sc);
  x.beginPath();
  x.moveTo(bx+r, by);
  x.lineTo(bx+bw-fold, by);
  x.lineTo(bx+bw, by+fold);
  x.lineTo(bx+bw, by+bh-r);
  x.arcTo(bx+bw, by+bh, bx+bw-r, by+bh, r);
  x.lineTo(bx+r, by+bh);
  x.arcTo(bx, by+bh, bx, by+bh-r, r);
  x.lineTo(bx, by+r);
  x.arcTo(bx, by, bx+r, by, r);
  x.closePath();
  var g=x.createLinearGradient(0,0,0,64);
  g.addColorStop(0,'#ff4444');
  g.addColorStop(1,'#cc2233');
  x.fillStyle=g;x.fill();
  x.beginPath();
  x.moveTo(bx+bw-fold, by);
  x.lineTo(bx+bw-fold, by+fold);
  x.lineTo(bx+bw, by+fold);
  x.closePath();
  x.fillStyle='rgba(0,0,0,0.15)';x.fill();
  x.fillStyle='#fff';
  x.font='bold 20px Arial,sans-serif';
  x.textAlign='center';x.textBaseline='middle';
  x.fillText('PDF',bx+bw/2, by+bh/2+4);
  x.restore();
}
(() => {
  var fc=document.createElement('canvas');fc.width=64;fc.height=64;
  drawPdfIcon(fc);
  document.getElementById('favicon').href=fc.toDataURL('image/png');
})();
const headerCanvas = document.getElementById('headerLogo');
if (headerCanvas) drawPdfIcon(headerCanvas);

// ===== TAB =====
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.tab === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach(p => {
    const active = p.id === 'panel-' + tab;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
}

// ===== UTILS =====
function downloadBlob(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = sanitizeDownloadName(name);
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitizeDownloadName(name) {
  const cleaned = String(name)
    .replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160);
  return cleaned || 'document.pdf';
}

function baseName(fname) {
  return sanitizeDownloadName(fname.replace(/\.pdf$/i, '')).slice(0, 140);
}

function setStatus(scope, text, isError = false) {
  const status = document.getElementById(`${scope}-status`);
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function setProgressBar(element, percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  element.setAttribute('aria-valuenow', String(value));
  const fill = element.querySelector('.fill');
  if (fill) fill.style.width = `${value}%`;
}

function humanError(error) {
  if (error?.name === 'EncryptedPDFError' || /encrypted|password/i.test(error?.message || '')) {
    return msg('パスワード保護されたPDFには対応していません。', 'Password-protected PDFs are not supported.');
  }
  return error?.message || msg('PDFを処理できませんでした。', 'The PDF could not be processed.');
}

function showDropError(dropId, text = '') {
  const drop = document.getElementById(dropId);
  let error = drop.querySelector('.drop-error');
  if (!error) {
    error = document.createElement('div');
    error.className = 'drop-error';
    error.setAttribute('role', 'alert');
    drop.appendChild(error);
  }
  error.textContent = text;
  error.classList.toggle('visible', Boolean(text));
}

async function validatePdfFile(file) {
  if (!(file instanceof File) || file.size === 0) {
    throw new Error(msg('空のファイルは読み込めません。', 'Empty files cannot be loaded.'));
  }
  if (!/\.pdf$/i.test(file.name)) {
    throw new Error(msg('拡張子が.pdfのファイルを選択してください。', 'Choose a file with a .pdf extension.'));
  }
  if (file.size > LIMITS.maxFileBytes) {
    throw new Error(msg('ファイルサイズは100MB以下にしてください。', 'PDF files must be 100 MB or smaller.'));
  }
  const header = new TextDecoder('latin1').decode(await file.slice(0, 1024).arrayBuffer());
  if (!header.includes('%PDF-')) {
    throw new Error(msg('PDFの内容を確認できませんでした。', 'The file does not contain a valid PDF header.'));
  }
}

function ensurePageCount(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(msg('ページのないPDFは処理できません。', 'PDFs without pages cannot be processed.'));
  }
  if (count > LIMITS.maxPages) {
    throw new Error(msg(`ページ数は${LIMITS.maxPages}以下にしてください。`, `PDFs are limited to ${LIMITS.maxPages} pages.`));
  }
}

function ensureCanvasSize(viewport, runningTotal = 0) {
  const pixels = Math.ceil(viewport.width) * Math.ceil(viewport.height);
  if (!Number.isFinite(pixels) || pixels <= 0 || pixels > LIMITS.maxCanvasPixels) {
    throw new Error(msg('ページの描画サイズが大きすぎます。DPIを下げてください。', 'A page is too large to render safely. Lower the DPI.'));
  }
  if (runningTotal + pixels > LIMITS.maxTotalCanvasPixels) {
    throw new Error(msg('PDF全体の描画量が安全上限を超えています。', 'The PDF exceeds the safe total rendering limit.'));
  }
  return runningTotal + pixels;
}

function pdfJsOptions(data) {
  const source = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return {
    data: source,
    isEvalSupported: false,
    stopAtErrors: true,
    enableXfa: false,
    maxImageSize: LIMITS.maxCanvasPixels,
    canvasMaxAreaInBytes: LIMITS.maxCanvasPixels * 4,
    cMapUrl: new URL('cmaps/', PDFJS_ROOT).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', PDFJS_ROOT).href,
    wasmUrl: new URL('wasm/', PDFJS_ROOT).href,
    useWasm: true,
  };
}

async function openPdfJs(data) {
  const task = getDocument(pdfJsOptions(data));
  try {
    const doc = await task.promise;
    ensurePageCount(doc.numPages);
    return { task, doc };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
}

function setupDrop(dropId, inputId, handler, multi) {
  const drop = document.getElementById(dropId), input = document.getElementById(inputId);
  const processFiles = async files => {
    showDropError(dropId);
    const selected = multi ? [...files] : [...files].slice(0, 1);
    for (const file of selected) {
      try {
        await validatePdfFile(file);
        await handler(file);
      } catch (error) {
        showDropError(dropId, humanError(error));
        if (!multi) break;
      }
    }
  };
  input.addEventListener('change', async e => {
    await processFiles(e.target.files);
    input.value = '';
  });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('dragover');
    await processFiles(e.dataTransfer.files);
  });
}

function showFileInfo(elId, name, pages, size, resetFn) {
  const host = document.getElementById(elId);
  host.replaceChildren();
  const info = document.createElement('div');
  info.className = 'file-info';
  const icon = document.createElement('div');
  icon.className = 'fi-icon';
  icon.textContent = 'PDF';
  const details = document.createElement('div');
  const fileName = document.createElement('div');
  fileName.className = 'fi-name';
  fileName.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'fi-meta';
  meta.textContent = `${pages !== null ? `${pages}${msg('ページ', 'p.')} · ` : ''}${formatSize(size)}`;
  details.append(fileName, meta);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'fi-remove';
  remove.dataset.action = resetFn;
  remove.dataset.actionArgs = '[]';
  remove.title = msg('削除', 'Remove');
  remove.setAttribute('aria-label', `${name} — ${remove.title}`);
  remove.textContent = '×';
  info.append(icon, details, remove);
  host.appendChild(info);
}

// ===== SPLIT =====
let splitBytes = null, splitPageCount = 0, splitPoints = new Set(), splitFileName = '';
setupDrop('split-drop', 'split-file-input', loadSplitFile);

async function loadSplitFile(file) {
  splitBytes = await file.arrayBuffer();
  splitFileName = baseName(file.name);
  const pdf = await PDFDocument.load(splitBytes);
  splitPageCount = pdf.getPageCount();
  ensurePageCount(splitPageCount);
  splitPoints.clear();
  showFileInfo('split-file-info', file.name, splitPageCount, file.size, 'resetSplit');
  const grid = document.getElementById('split-grid'); grid.innerHTML = '';
  for (let i = 1; i <= splitPageCount; i++) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-chip'; chip.textContent = i; chip.dataset.page = i;
    chip.setAttribute('aria-label', msg(`${i}ページの後で分割`, `Split after page ${i}`));
    if (i < splitPageCount) chip.addEventListener('click', () => { toggleSplit(i, chip); });
    grid.appendChild(chip);
  }
  document.getElementById('split-controls').classList.remove('hidden');
  updateSplitPreview();
}
function toggleSplit(p, chip) {
  splitPoints.has(p) ? splitPoints.delete(p) : splitPoints.add(p);
  chip.classList.toggle('split-after');
  updateSplitPreview();
}
function updateSplitPreview() {
  const sorted = [...splitPoints].sort((a,b) => a-b);
  const chunks = []; let s = 1;
  for (const sp of sorted) { chunks.push({start:s,end:sp}); s=sp+1; }
  chunks.push({start:s,end:splitPageCount});
  document.getElementById('split-count').textContent = msg(`${splitPoints.size}箇所`, `${splitPoints.size} split${splitPoints.size === 1 ? '' : 's'}`);
  document.getElementById('split-preview').innerHTML = chunks.map((c,i) =>
    `<div class="split-chunk"><span class="chunk-label">${msg(`ファイル${i+1}`, `File ${i+1}`)}</span><span class="chunk-pages">p.${c.start}${c.start===c.end?'':`–${c.end}`}</span></div>`
  ).join('');
  document.getElementById('split-btn').disabled = splitPoints.size === 0;
}
async function executeSplit() {
  const btn = document.getElementById('split-btn'), status = document.getElementById('split-status'), prog = document.getElementById('split-progress');
  btn.disabled = true; setStatus('split', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 0);
  const sorted = [...splitPoints].sort((a,b) => a-b);
  const ranges = []; let s = 0;
  for (const sp of sorted) { ranges.push([s, sp-1]); s = sp; }
  ranges.push([s, splitPageCount-1]);
  for (let i = 0; i < ranges.length; i++) {
    setProgressBar(prog, ((i+1)/ranges.length)*100);
    const src = await PDFDocument.load(splitBytes);
    const np = await PDFDocument.create();
    const idx = []; for (let p = ranges[i][0]; p <= ranges[i][1]; p++) idx.push(p);
    (await np.copyPages(src, idx)).forEach(pg => np.addPage(pg));
    downloadBlob(await np.save(), `${splitFileName}_p${ranges[i][0]+1}-${ranges[i][1]+1}.pdf`);
    await sleep(300);
  }
  setStatus('split', msg(`✓ ${ranges.length}ファイルをダウンロードしました`, `✓ Downloaded ${ranges.length} file${ranges.length === 1 ? '' : 's'}`)); btn.disabled = false;
  setTimeout(() => prog.classList.remove('active'), 1000);
}
function resetSplit() {
  splitBytes = null; splitPageCount = 0; splitPoints.clear();
  document.getElementById('split-file-info').innerHTML = '';
  document.getElementById('split-controls').classList.add('hidden');
  setStatus('split', '');
  document.getElementById('split-file-input').value = '';
}

// ===== MERGE =====
let mergeFiles = [], mergeIdCtr = 0, mergeDragId = null;
setupDrop('merge-drop', 'merge-file-input', addMergeFile, true);

async function addMergeFile(file) {
  const bytes = await file.arrayBuffer();
  const pdf = await PDFDocument.load(bytes);
  const pageCount = pdf.getPageCount();
  ensurePageCount(pageCount);
  if (mergeFiles.reduce((sum, item) => sum + item.pageCount, 0) + pageCount > LIMITS.maxPages) {
    throw new Error(msg(`結合後のページ数は${LIMITS.maxPages}以下にしてください。`, `The merged PDF is limited to ${LIMITS.maxPages} pages.`));
  }
  mergeFiles.push({ id:++mergeIdCtr, name:file.name, size:file.size, bytes, pageCount });
  renderMergeList();
}
function renderMergeList() {
  const list = document.getElementById('merge-list'); list.innerHTML = '';
  mergeFiles.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'merge-item'; item.draggable = true; item.dataset.id = f.id;
    item.innerHTML = `<span class="grip" aria-hidden="true">⋮⋮</span><span class="order-num">${idx+1}</span><span class="mi-name">${escHtml(f.name)}</span><span class="mi-pages">${f.pageCount}p</span><span class="item-actions"><button type="button" class="move-btn" data-action="moveMergeFile" data-action-args="[${f.id},-1]" aria-label="${msg('上へ移動', 'Move up')}" ${idx === 0 ? 'disabled' : ''}>↑</button><button type="button" class="move-btn" data-action="moveMergeFile" data-action-args="[${f.id},1]" aria-label="${msg('下へ移動', 'Move down')}" ${idx === mergeFiles.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="mi-remove" data-action="removeMergeFile" data-action-args="[${f.id}]" aria-label="${msg('削除', 'Remove')}">×</button></span>`;
    item.addEventListener('dragstart', e => { mergeDragId = f.id; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); document.querySelectorAll('.merge-item.drag-over').forEach(el => el.classList.remove('drag-over')); mergeDragId = null; });
    item.addEventListener('dragover', e => { e.preventDefault(); if (f.id !== mergeDragId) item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-over');
      if (!mergeDragId || mergeDragId === f.id) return;
      const fi = mergeFiles.findIndex(x => x.id === mergeDragId), ti = mergeFiles.findIndex(x => x.id === f.id);
      const [m] = mergeFiles.splice(fi, 1); mergeFiles.splice(ti, 0, m);
      renderMergeList();
    });
    list.appendChild(item);
  });
  document.getElementById('merge-controls').classList.toggle('hidden', mergeFiles.length < 2);
}
function removeMergeFile(id) { mergeFiles = mergeFiles.filter(f => f.id !== id); renderMergeList(); }
function moveMergeFile(id, delta) {
  const index = mergeFiles.findIndex(file => file.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= mergeFiles.length) return;
  [mergeFiles[index], mergeFiles[next]] = [mergeFiles[next], mergeFiles[index]];
  renderMergeList();
}
async function executeMerge() {
  const btn = document.getElementById('merge-btn'), status = document.getElementById('merge-status'), prog = document.getElementById('merge-progress');
  btn.disabled = true; setStatus('merge', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 0);
  const merged = await PDFDocument.create();
  for (let i = 0; i < mergeFiles.length; i++) {
    setProgressBar(prog, ((i+1)/mergeFiles.length)*100);
    const src = await PDFDocument.load(mergeFiles[i].bytes);
    (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
    await sleep(100);
  }
  downloadBlob(await merged.save(), `${baseName(mergeFiles[0].name)}_merged.pdf`);
  const tp = mergeFiles.reduce((s, f) => s + f.pageCount, 0);
  setStatus('merge', msg(`✓ ${mergeFiles.length}ファイル（計${tp}ページ）を結合しました`, `✓ Merged ${mergeFiles.length} files (${tp} pages)`)); btn.disabled = false;
  setTimeout(() => prog.classList.remove('active'), 1000);
}
function resetMerge() { mergeFiles = []; mergeIdCtr = 0; renderMergeList(); setStatus('merge', ''); document.getElementById('merge-file-input').value = ''; }

// ===== EXTRACT =====
let extractBytes = null, extractPageCount = 0, extractSelected = new Set(), extractFileName = '';
setupDrop('extract-drop', 'extract-file-input', loadExtractFile);

async function loadExtractFile(file) {
  extractBytes = await file.arrayBuffer();
  extractFileName = baseName(file.name);
  const pdf = await PDFDocument.load(extractBytes);
  extractPageCount = pdf.getPageCount();
  ensurePageCount(extractPageCount);
  extractSelected.clear();
  showFileInfo('extract-file-info', file.name, extractPageCount, file.size, 'resetExtract');
  const grid = document.getElementById('extract-grid'); grid.innerHTML = '';
  for (let i = 1; i <= extractPageCount; i++) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-chip'; chip.textContent = i; chip.dataset.page = i;
    chip.setAttribute('aria-pressed', 'false');
    chip.setAttribute('aria-label', msg(`${i}ページを選択`, `Select page ${i}`));
    chip.addEventListener('click', () => {
      if (extractSelected.has(i)) { extractSelected.delete(i); chip.classList.remove('selected'); chip.setAttribute('aria-pressed', 'false'); }
      else { extractSelected.add(i); chip.classList.add('selected'); chip.setAttribute('aria-pressed', 'true'); }
      updateExtractCount();
    });
    grid.appendChild(chip);
  }
  document.getElementById('extract-controls').classList.remove('hidden');
  updateExtractCount();
}
function updateExtractCount() {
  document.getElementById('extract-count').textContent = msg(`${extractSelected.size}ページ`, `${extractSelected.size} page${extractSelected.size === 1 ? '' : 's'}`);
  document.getElementById('extract-btn').disabled = extractSelected.size === 0;
}
function extractSelectAll() {
  extractSelected.clear();
  document.querySelectorAll('#extract-grid .page-chip').forEach(c => { extractSelected.add(+c.dataset.page); c.classList.add('selected'); c.setAttribute('aria-pressed', 'true'); });
  updateExtractCount();
}
function extractDeselectAll() {
  extractSelected.clear();
  document.querySelectorAll('#extract-grid .page-chip').forEach(c => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
  updateExtractCount();
}
async function executeExtract() {
  const btn = document.getElementById('extract-btn'), status = document.getElementById('extract-status'), prog = document.getElementById('extract-progress');
  btn.disabled = true; setStatus('extract', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 50);
  const src = await PDFDocument.load(extractBytes);
  const np = await PDFDocument.create();
  const sorted = [...extractSelected].sort((a, b) => a - b);
  (await np.copyPages(src, sorted.map(p => p - 1))).forEach(pg => np.addPage(pg));
  const extName = sorted.length <= 4
    ? `${extractFileName}_extracted_p${sorted.join('_p')}.pdf`
    : `${extractFileName}_extracted_${sorted.length}pages.pdf`;
  downloadBlob(await np.save(), extName);
  setProgressBar(prog, 100);
  setStatus('extract', msg(`✓ ${sorted.length}ページを抽出しました`, `✓ Extracted ${sorted.length} page${sorted.length === 1 ? '' : 's'}`)); btn.disabled = false;
  setTimeout(() => prog.classList.remove('active'), 1000);
}
function resetExtract() {
  extractBytes = null; extractPageCount = 0; extractSelected.clear();
  document.getElementById('extract-file-info').innerHTML = '';
  document.getElementById('extract-controls').classList.add('hidden');
  setStatus('extract', '');
  document.getElementById('extract-file-input').value = '';
}

// ===== ROTATE =====
let rotateBytes = null, rotatePageCount = 0, rotateAngles = [], rotateFileName = '';
setupDrop('rotate-drop', 'rotate-file-input', loadRotateFile);

async function loadRotateFile(file) {
  rotateBytes = await file.arrayBuffer();
  rotateFileName = baseName(file.name);
  const pdf = await PDFDocument.load(rotateBytes);
  rotatePageCount = pdf.getPageCount();
  ensurePageCount(rotatePageCount);
  rotateAngles = new Array(rotatePageCount).fill(0);
  showFileInfo('rotate-file-info', file.name, rotatePageCount, file.size, 'resetRotate');
  renderRotateGrid();
  document.getElementById('rotate-controls').classList.remove('hidden');
  updateRotateBtn();
}
function renderRotateGrid() {
  const grid = document.getElementById('rotate-grid'); grid.innerHTML = '';
  for (let i = 0; i < rotatePageCount; i++) {
    const card = document.createElement('div'); card.className = 'rotate-card';
    card.innerHTML = `
      <div class="rc-page">p.${i + 1}</div>
      <div class="rc-preview" id="rc-prev-${i}" style="transform:rotate(${rotateAngles[i]}deg)">
        <span style="font-size:10px;opacity:0.4;">A</span>
      </div>
      <div class="rc-angle" id="rc-angle-${i}">${rotateAngles[i] === 0 ? '' : rotateAngles[i] + '°'}</div>
      <div class="rc-btns">
        <button type="button" class="rc-btn" data-action="rotatePage" data-action-args="[${i},-90]" title="-90°" aria-label="${msg(`${i + 1}ページを左へ90度回転`, `Rotate page ${i + 1} left 90 degrees`)}">↶</button>
        <button type="button" class="rc-btn" data-action="rotatePage" data-action-args="[${i},90]" title="+90°" aria-label="${msg(`${i + 1}ページを右へ90度回転`, `Rotate page ${i + 1} right 90 degrees`)}">↷</button>
      </div>`;
    grid.appendChild(card);
  }
}
function rotatePage(idx, delta) {
  rotateAngles[idx] = ((rotateAngles[idx] + delta) % 360 + 360) % 360;
  document.getElementById(`rc-prev-${idx}`).style.transform = `rotate(${rotateAngles[idx]}deg)`;
  document.getElementById(`rc-angle-${idx}`).textContent = rotateAngles[idx] === 0 ? '' : rotateAngles[idx] + '°';
  updateRotateBtn();
}
function rotateAllPages(angle) {
  for (let i = 0; i < rotatePageCount; i++) {
    rotateAngles[i] = angle;
    document.getElementById(`rc-prev-${i}`).style.transform = `rotate(${angle}deg)`;
    document.getElementById(`rc-angle-${i}`).textContent = angle === 0 ? '' : angle + '°';
  }
  updateRotateBtn();
}
function updateRotateBtn() {
  document.getElementById('rotate-btn').disabled = rotateAngles.every(a => a === 0);
}
async function executeRotate() {
  const btn = document.getElementById('rotate-btn'), status = document.getElementById('rotate-status'), prog = document.getElementById('rotate-progress');
  btn.disabled = true; setStatus('rotate', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 50);
  const pdf = await PDFDocument.load(rotateBytes);
  for (let i = 0; i < rotatePageCount; i++) {
    if (rotateAngles[i] !== 0) {
      const page = pdf.getPage(i);
      const cur = page.getRotation().angle;
      page.setRotation(degrees((cur + rotateAngles[i]) % 360));
    }
  }
  downloadBlob(await pdf.save(), `${rotateFileName}_rotated.pdf`);
  setProgressBar(prog, 100);
  const changed = rotateAngles.filter(a => a !== 0).length;
  setStatus('rotate', msg(`✓ ${changed}ページを回転しました`, `✓ Rotated ${changed} page${changed === 1 ? '' : 's'}`)); btn.disabled = false;
  setTimeout(() => prog.classList.remove('active'), 1000);
}
function resetRotate() {
  rotateBytes = null; rotatePageCount = 0; rotateAngles = [];
  document.getElementById('rotate-file-info').innerHTML = '';
  document.getElementById('rotate-controls').classList.add('hidden');
  setStatus('rotate', '');
  document.getElementById('rotate-file-input').value = '';
}

// ===== REORDER =====
let reorderBytes = null, reorderPageCount = 0, reorderOrder = [], reorderFileName = '';
let reorderDragIdx = null;
setupDrop('reorder-drop', 'reorder-file-input', loadReorderFile);

async function loadReorderFile(file) {
  reorderBytes = await file.arrayBuffer();
  reorderFileName = baseName(file.name);
  const pdf = await PDFDocument.load(reorderBytes);
  reorderPageCount = pdf.getPageCount();
  ensurePageCount(reorderPageCount);
  reorderOrder = Array.from({ length: reorderPageCount }, (_, i) => i);
  showFileInfo('reorder-file-info', file.name, reorderPageCount, file.size, 'resetReorder');
  renderReorderList();
  document.getElementById('reorder-controls').classList.remove('hidden');
}
function renderReorderList() {
  const list = document.getElementById('reorder-list'); list.innerHTML = '';
  reorderOrder.forEach((origIdx, pos) => {
    const item = document.createElement('div');
    item.className = 'reorder-item'; item.draggable = true; item.dataset.pos = pos;
    const moved = origIdx !== pos;
    item.innerHTML = `
      <span class="ri-grip" aria-hidden="true">⋮⋮</span>
      <span class="ri-num">${pos + 1}</span>
      <span class="ri-label">${msg(`ページ ${origIdx + 1}`, `Page ${origIdx + 1}`)}</span>
      <span class="ri-orig">${moved ? msg(`元: p.${origIdx + 1}`, `Original: p.${origIdx + 1}`) : ''}</span>
      <span class="item-actions"><button type="button" class="move-btn" data-action="moveReorderPage" data-action-args="[${pos},-1]" aria-label="${msg('上へ移動', 'Move up')}" ${pos === 0 ? 'disabled' : ''}>↑</button><button type="button" class="move-btn" data-action="moveReorderPage" data-action-args="[${pos},1]" aria-label="${msg('下へ移動', 'Move down')}" ${pos === reorderOrder.length - 1 ? 'disabled' : ''}>↓</button></span>`;
    item.addEventListener('dragstart', e => { reorderDragIdx = pos; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); document.querySelectorAll('.reorder-item.drag-over').forEach(el => el.classList.remove('drag-over')); reorderDragIdx = null; });
    item.addEventListener('dragover', e => { e.preventDefault(); if (pos !== reorderDragIdx) item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-over');
      if (reorderDragIdx === null || reorderDragIdx === pos) return;
      const [moved] = reorderOrder.splice(reorderDragIdx, 1);
      reorderOrder.splice(pos, 0, moved);
      renderReorderList();
    });
    list.appendChild(item);
  });
}
function moveReorderPage(pos, direction) {
  const next = pos + direction;
  if (pos < 0 || next < 0 || pos >= reorderOrder.length || next >= reorderOrder.length) return;
  [reorderOrder[pos], reorderOrder[next]] = [reorderOrder[next], reorderOrder[pos]];
  renderReorderList();
}
function reverseReorder() { reorderOrder.reverse(); renderReorderList(); }
function resetReorderOrder() { reorderOrder = Array.from({ length: reorderPageCount }, (_, i) => i); renderReorderList(); }
async function executeReorder() {
  if (!reorderBytes) return;
  const btn = document.getElementById('reorder-btn'), prog = document.getElementById('reorder-progress');
  btn.disabled = true; setStatus('reorder', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 35);
  try {
    const src = await PDFDocument.load(reorderBytes);
    const np = await PDFDocument.create();
    (await np.copyPages(src, reorderOrder)).forEach(pg => np.addPage(pg));
    setProgressBar(prog, 85);
    downloadBlob(await np.save(), `${reorderFileName}_reordered.pdf`);
    setProgressBar(prog, 100);
    setStatus('reorder', msg('✓ 並べ替えたPDFをダウンロードしました', '✓ Downloaded the reordered PDF'));
  } finally {
    btn.disabled = false;
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetReorder() {
  reorderBytes = null; reorderPageCount = 0; reorderOrder = [];
  document.getElementById('reorder-file-info').innerHTML = '';
  document.getElementById('reorder-controls').classList.add('hidden');
  setStatus('reorder', '');
  document.getElementById('reorder-file-input').value = '';
}

// ===== COMPRESS =====
let compressFile = null, compressedBytes = null, compressGeneration = 0;

// Slider listeners
document.getElementById('compress-quality').addEventListener('input', function() {
  document.getElementById('compress-quality-val').textContent = this.value + '%';
});
document.getElementById('compress-dpi').addEventListener('input', function() {
  document.getElementById('compress-dpi-val').textContent = this.value + ' DPI';
});
document.getElementById('compress-target').addEventListener('change', function() {
  if (compressFile) void calibrateCompress(compressFile);
});

setupDrop('compress-drop', 'compress-file-input', loadCompressFile);

async function loadCompressFile(file) {
  compressFile = file;
  compressedBytes = null;
  showFileInfo('compress-file-info', file.name, null, file.size, 'resetCompress');
  document.getElementById('compress-btn').disabled = true;
  document.getElementById('compress-result').style.display = 'none';
  document.getElementById('compress-progress-wrap').style.display = 'none';
  setStatus('compress', '');
  document.getElementById('quality-badge').style.display = 'none';
  document.getElementById('dpi-badge').style.display = 'none';
  await calibrateCompress(file);
}

function abortIfStale(generation, file) {
  if (generation !== compressGeneration || file !== compressFile) {
    throw new DOMException('A newer compression request replaced this one.', 'AbortError');
  }
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) {
        reject(new Error(msg('ページ画像を作成できませんでした。', 'Could not create the page image.')));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', quality);
  });
}

async function renderPageToJpeg(pdfDoc, pageNumber, dpi, quality, runningTotal = 0) {
  const page = await pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: dpi / 72 });
  const nextTotal = ensureCanvasSize(viewport, runningTotal);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return {
      bytes: await canvasToJpeg(canvas, quality),
      width: baseViewport.width,
      height: baseViewport.height,
      runningTotal: nextTotal,
    };
  } finally {
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function calibrateCompress(file) {
  const generation = ++compressGeneration;
  const calibBar = document.getElementById('calib-bar');
  const calibMsg = document.getElementById('calib-msg');
  const btn = document.getElementById('compress-btn');
  const targetMB = parseFloat(document.getElementById('compress-target').value) || 10;
  const requestedBytes = targetMB * 1024 * 1024;
  const targetBytes = Math.max(1, Math.min(requestedBytes, file.size * 0.95));
  let loadingTask = null;

  btn.disabled = true;
  calibBar.className = 'calib-bar';
  calibBar.style.display = 'flex';
  calibMsg.textContent = msg('最適な設定を自動で探しています…', 'Finding safe compression settings…');

  try {
    const arrayBuf = await file.arrayBuffer();
    abortIfStale(generation, file);
    const opened = await openPdfJs(arrayBuf);
    loadingTask = opened.task;
    const pdfDoc = opened.doc;
    const numPages = pdfDoc.numPages;
    const samplePages = [...new Set([1, Math.ceil(numPages / 2), numPages])];

    const estimatePdfSize = async (dpi, quality) => {
      const out = await PDFDocument.create();
      let runningTotal = 0;
      for (const pageNumber of samplePages) {
        abortIfStale(generation, file);
        const rendered = await renderPageToJpeg(pdfDoc, pageNumber, dpi, quality / 100, runningTotal);
        runningTotal = rendered.runningTotal;
        const img = await out.embedJpg(rendered.bytes);
        out.addPage([rendered.width, rendered.height]).drawImage(img, { x: 0, y: 0, width: rendered.width, height: rendered.height });
      }
      const sampleSize = (await out.save({ useObjectStreams: true })).byteLength;
      return sampleSize * numPages / samplePages.length;
    };

    calibMsg.textContent = msg('サンプル計測中 (1/2)…', 'Measuring samples (1/2)…');
    const size150q95 = await estimatePdfSize(150, 95);
    let bestQuality = 95, bestDpi = 150;

    if (size150q95 <= targetBytes) {
      const newDpi = Math.min(300, Math.round(150 * Math.sqrt(targetBytes / size150q95) / 6) * 6);
      bestDpi = newDpi; bestQuality = 95;
    } else {
      calibMsg.textContent = msg('サンプル計測中 (2/2)…', 'Measuring samples (2/2)…');
      const size150q30 = await estimatePdfSize(150, 30);
      if (targetBytes >= size150q30) {
        const range = Math.max(1, size150q95 - size150q30);
        const t = (targetBytes - size150q30) / range;
        bestQuality = Math.max(10, Math.min(95, Math.round(30 + t * 65)));
        bestDpi = 150;
      } else {
        const newDpi = Math.max(72, Math.round(150 * Math.sqrt(targetBytes / size150q30) / 6) * 6);
        bestQuality = 30; bestDpi = newDpi;
      }
    }

    abortIfStale(generation, file);
    document.getElementById('compress-quality').value = bestQuality;
    document.getElementById('compress-quality-val').textContent = bestQuality + '%';
    document.getElementById('compress-dpi').value = bestDpi;
    document.getElementById('compress-dpi-val').textContent = bestDpi + ' DPI';
    document.getElementById('quality-badge').style.display = 'block';
    document.getElementById('dpi-badge').style.display = 'block';

    calibBar.className = 'calib-bar calib-done';
    calibMsg.textContent = msg('✓ 自動設定完了 — スライダーを調整しました', '✓ Automatic settings applied — you can fine-tune the sliders');
    btn.disabled = false;

  } catch(e) {
    if (e.name !== 'AbortError') {
      console.error('Calibration error:', e);
      calibBar.className = 'calib-bar calib-error';
      calibMsg.textContent = msg('自動設定に失敗しました。手動設定で実行できます。', 'Automatic settings failed. You can still use manual settings.');
      setStatus('compress', humanError(e), true);
      if (file === compressFile) btn.disabled = false;
    }
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => {});
  }
}

function copyCompressionMetadata(outDoc, metadata) {
  const info = metadata?.info || {};
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 1000) : '';
  if (clean(info.Title)) outDoc.setTitle(clean(info.Title));
  if (clean(info.Author)) outDoc.setAuthor(clean(info.Author));
  if (clean(info.Subject)) outDoc.setSubject(clean(info.Subject));
  if (clean(info.Creator)) outDoc.setCreator(clean(info.Creator));
  if (clean(info.Producer)) outDoc.setProducer(clean(info.Producer));
  if (clean(info.Keywords)) outDoc.setKeywords(clean(info.Keywords).split(/[,;]+/).map(v => v.trim()).filter(Boolean));
}

async function executeCompress() {
  if (!compressFile) return;
  ++compressGeneration;
  const btn = document.getElementById('compress-btn');
  const progWrap = document.getElementById('compress-progress-wrap');
  const progFill = document.getElementById('compress-progress-fill');
  const progText = document.getElementById('compress-progress-text');
  const progPct  = document.getElementById('compress-progress-pct');

  const targetMB = parseFloat(document.getElementById('compress-target').value) || 10;
  const targetBytes = targetMB * 1024 * 1024;
  const quality = parseInt(document.getElementById('compress-quality').value) / 100;
  const dpi = parseInt(document.getElementById('compress-dpi').value);
  const rmMeta = document.getElementById('compress-meta').checked;

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${msg('圧縮中…', 'Compressing…')}`;
  progWrap.style.display = 'block';
  document.getElementById('compress-result').style.display = 'none';
  setStatus('compress', '');
  let loadingTask = null;

  const setProgress = (pct, label) => {
    const safePct = Math.max(0, Math.min(100, Math.round(pct)));
    progFill.style.width = safePct + '%';
    progWrap.setAttribute('aria-valuenow', String(safePct));
    progText.textContent = label;
    progPct.textContent = safePct + '%';
  };

  try {
    const originalArray = await compressFile.arrayBuffer();
    const originalSize = originalArray.byteLength;

    setProgress(5, msg('PDF解析中…', 'Parsing PDF…'));
    const opened = await openPdfJs(originalArray);
    loadingTask = opened.task;
    const pdfDoc = opened.doc;
    const numPages = pdfDoc.numPages;
    const metadata = rmMeta ? null : await pdfDoc.getMetadata().catch(() => null);
    const outDoc = await PDFDocument.create();
    let runningTotal = 0;

    for (let i = 1; i <= numPages; i++) {
      const pct = 8 + ((i - 1) / numPages) * 82;
      setProgress(pct, msg(`レンダリング・構築中… (${i} / ${numPages}ページ)`, `Rendering and building… (${i} / ${numPages} pages)`));
      const rendered = await renderPageToJpeg(pdfDoc, i, dpi, quality, runningTotal);
      runningTotal = rendered.runningTotal;
      const img = await outDoc.embedJpg(rendered.bytes);
      outDoc.addPage([rendered.width, rendered.height]).drawImage(img, { x: 0, y: 0, width: rendered.width, height: rendered.height });
      await sleep(0);
    }

    if (rmMeta) {
      outDoc.setTitle(''); outDoc.setAuthor(''); outDoc.setSubject('');
      outDoc.setKeywords([]); outDoc.setProducer(''); outDoc.setCreator('');
    } else {
      copyCompressionMetadata(outDoc, metadata);
    }

    setProgress(94, msg('PDF出力中…', 'Writing PDF…'));
    const outBytes = await outDoc.save({ useObjectStreams: true });
    setProgress(100, msg('完了！', 'Complete!'));
    compressedBytes = outBytes;

    const afterSize = outBytes.byteLength;
    const ratio = Math.round((1 - afterSize / originalSize) * 100);

    document.getElementById('compress-stat-before').textContent = formatSize(originalSize);
    document.getElementById('compress-stat-after').textContent = formatSize(afterSize);
    document.getElementById('compress-stat-ratio').textContent = (ratio >= 0 ? '-' : '+') + Math.abs(ratio) + '%';

    const warnEl = document.getElementById('compress-warn');
    const warnings = [];
    if (afterSize >= originalSize) {
      warnings.push(msg('元ファイルより小さくなりませんでした。', 'The result is not smaller than the original.'));
    }
    if (afterSize > targetBytes) {
      warnings.push(msg(`目標 ${targetMB}MB を超えています（${formatSize(afterSize)}）。品質またはDPIを下げてください。`, `The result exceeds the ${targetMB} MB target (${formatSize(afterSize)}). Lower quality or DPI.`));
    }
    if (warnings.length) {
      warnEl.style.display = 'block';
      warnEl.textContent = `⚠ ${warnings.join(' ')}`;
    } else {
      warnEl.style.display = 'none';
    }

    document.getElementById('compress-result').style.display = 'block';
    setStatus('compress', msg('✓ 圧縮処理が完了しました', '✓ Compression complete'));
    setTimeout(() => document.getElementById('compress-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  } catch(err) {
    console.error(err);
    setStatus('compress', `${msg('エラー: ', 'Error: ')}${humanError(err)}`, true);
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => {});
    btn.disabled = !compressFile;
    btn.innerHTML = msg('🗜️ 圧縮を実行', '🗜️ Compress PDF');
    setTimeout(() => { progWrap.style.display = 'none'; }, 800);
  }
}

document.getElementById('compress-download-btn').addEventListener('click', () => {
  if (!compressedBytes || !compressFile) return;
  downloadBlob(compressedBytes, baseName(compressFile.name) + '_compressed.pdf');
});

function resetCompress() {
  ++compressGeneration;
  compressFile = null; compressedBytes = null;
  document.getElementById('compress-file-info').innerHTML = '';
  document.getElementById('calib-bar').style.display = 'none';
  document.getElementById('compress-btn').disabled = true;
  document.getElementById('compress-result').style.display = 'none';
  document.getElementById('compress-progress-wrap').style.display = 'none';
  setStatus('compress', '');
  document.getElementById('compress-file-input').value = '';
  document.getElementById('quality-badge').style.display = 'none';
  document.getElementById('dpi-badge').style.display = 'none';
  document.getElementById('compress-quality').value = 70;
  document.getElementById('compress-quality-val').textContent = '70%';
  document.getElementById('compress-dpi').value = 150;
  document.getElementById('compress-dpi-val').textContent = '150 DPI';
}

// ===== TRIM =====
let trimFile = null, trimBytes = null, trimFileName = '';
let trimPdfDoc = null, trimPdfTask = null, trimPageCount = 0;
let trimMode = 'all'; // 'all' | 'per'
let trimCurrentPage = 1; // 全ページモードのプレビューページ
let trimPerCurrentPage = 1; // ページごとモードの現在ページ
let trimAllSel = null; // 全ページ共通の選択（canvas比率 {x1,y1,x2,y2}）
let trimPerSel = {}; // { [pageNum]: {x1,y1,x2,y2} } canvas比率
let trimPageSizes = []; // 各ページのPDFサイズ { width, height } in pt
const TRIM_PREVIEW_SCALE = 1.5; // render DPI factor (72 * scale)

setupDrop('trim-drop', 'trim-file-input', loadTrimFile);

async function loadTrimFile(file) {
  if (trimPdfTask) await trimPdfTask.destroy().catch(() => {});
  trimFile = file;
  trimFileName = baseName(file.name);
  trimBytes = await file.arrayBuffer();
  const opened = await openPdfJs(trimBytes);
  trimPdfTask = opened.task;
  trimPdfDoc = opened.doc;
  trimPageCount = trimPdfDoc.numPages;
  trimPerSel = {};
  trimAllSel = null;
  trimCurrentPage = 1;
  trimPerCurrentPage = 1;

  // ページサイズはpdf.jsのviewport（表示と同じ向き）から取得
  trimPageSizes = [];
  for (let i = 1; i <= trimPageCount; i++) {
    const pg = await trimPdfDoc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    trimPageSizes.push({ width: vp.width, height: vp.height, rotate: pg.rotate || 0 });
  }

  showFileInfo('trim-file-info', file.name, trimPageCount, file.size, 'resetTrim');
  document.getElementById('trim-controls').classList.remove('hidden');
  document.getElementById('trim-btn').disabled = false;

  buildTrimPerPageList();
  await renderTrimPreview('all', 1);
  document.getElementById('trim-page-nav-all').style.display = trimPageCount > 1 ? 'flex' : 'none';
  updateTrimPageLabel('all');
  initTrimDrag('all');
}

function buildTrimPerPageList() {
  const list = document.getElementById('trim-per-page-list');
  list.innerHTML = '';
  for (let i = 1; i <= trimPageCount; i++) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'trim-per-page-item';
    item.id = `trim-per-item-${i}`;
    item.dataset.page = i;
    item.dataset.action = 'selectTrimPerPage';
    item.dataset.actionArgs = `[${i}]`;
    item.setAttribute('aria-label', msg(`ページ${i}を選択`, `Select page ${i}`));
    item.innerHTML = `<span class="tpp-num">P${i}</span><span class="tpp-dot" aria-hidden="true"></span>`;
    list.appendChild(item);
  }
  // 最初のページを選択
  selectTrimPerPage(1);
}

async function selectTrimPerPage(pageNum) {
  trimPerCurrentPage = pageNum;
  document.querySelectorAll('.trim-per-page-item').forEach(el => {
    const active = +el.dataset.page === pageNum;
    el.classList.toggle('active', active);
    el.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('trim-per-page-header').textContent = msg(`ページ ${pageNum} / ${trimPageCount} のトリミング範囲`, `Trim range for page ${pageNum} / ${trimPageCount}`);
  await renderTrimPreview('per', pageNum);
  // 保存済み設定を復元
  const saved = trimPerSel[pageNum];
  if (saved) {
    // pt → px (preview座標) 変換はrenderTrimPreview後に行う
    restoreTrimPerInputs(pageNum);
    updateTrimSelectionBox('per');
  } else {
    ['top','bottom','left','right'].forEach(d => { document.getElementById(`trim-${d}-per`).value = 0; });
    document.getElementById('trim-margin-per').value = 0;
    hideTrimSelection('per');
  }
  setStatus('trim', '');
  document.getElementById('trim-btn').disabled = false;
  initTrimDrag('per');
}

function restoreTrimPerInputs(pageNum) {
  const r = trimPerSel[pageNum];
  if (!r || r.x1 == null) return;
  const { width: ptW, height: ptH } = trimPageSizes[pageNum - 1];
  document.getElementById('trim-left-per').value   = Math.round(r.x1 * ptW);
  document.getElementById('trim-right-per').value  = Math.round((1 - r.x2) * ptW);
  document.getElementById('trim-top-per').value    = Math.round(r.y1 * ptH);
  document.getElementById('trim-bottom-per').value = Math.round((1 - r.y2) * ptH);
  document.getElementById('trim-margin-per').value = r.marginPt || 0;
}

async function renderTrimPreview(mode, pageNum) {
  const canvas = document.getElementById(`trim-canvas-${mode}`);
  const ctx = canvas.getContext('2d');
  const page = await trimPdfDoc.getPage(pageNum);
  // pdf.jsのviewportはrotation適用済み → pdf-libのgetSize()と同じ向きになる
  const viewport = page.getViewport({ scale: TRIM_PREVIEW_SCALE });
  ensureCanvasSize(viewport);
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
}

function updateTrimPageLabel(mode) {
  if (mode === 'all') {
    document.getElementById('trim-page-label-all').textContent = `${trimCurrentPage} / ${trimPageCount}`;
  }
}

async function trimNavPage(mode, dir) {
  if (mode !== 'all') return;
  const newPage = Math.min(trimPageCount, Math.max(1, trimCurrentPage + dir));
  if (newPage === trimCurrentPage) return;
  trimCurrentPage = newPage;
  updateTrimPageLabel('all');
  await renderTrimPreview('all', newPage);
  updateTrimSelectionBox('all');
  initTrimDrag('all');
}

// ===== ドラッグ選択 =====
// モードごとのドラッグ状態を管理（cloneNodeを使わずフラグで管理）
const trimDragState = { all: { active: false, startX: 0, startY: 0 }, per: { active: false, startX: 0, startY: 0 } };
let trimDragInitialized = false;

function initTrimDrag(mode) {
  // 初回のみwindowレベルのリスナーを登録
  if (!trimDragInitialized) {
    trimDragInitialized = true;

    window.addEventListener('mousemove', e => {
      ['all', 'per'].forEach(m => {
        if (!trimDragState[m].active) return;
        const container = document.getElementById(`trim-canvas-container-${m}`);
        const canvas2 = document.getElementById(`trim-canvas-${m}`);
        if (!container || !canvas2) return;
        const rect = container.getBoundingClientRect();
        const scaleX = canvas2.width / rect.width;
        const scaleY = canvas2.height / rect.height;
        const curX = Math.min(canvas2.width, Math.max(0, (e.clientX - rect.left) * scaleX));
        const curY = Math.min(canvas2.height, Math.max(0, (e.clientY - rect.top) * scaleY));
        const x1 = Math.min(trimDragState[m].startX, curX), y1 = Math.min(trimDragState[m].startY, curY);
        const x2 = Math.max(trimDragState[m].startX, curX), y2 = Math.max(trimDragState[m].startY, curY);
        applyTrimFromCanvas(m, x1, y1, x2, y2, canvas2.width, canvas2.height);
      });
    });

    window.addEventListener('mouseup', () => {
      trimDragState.all.active = false;
      trimDragState.per.active = false;
    });
  }

  const container = document.getElementById(`trim-canvas-container-${mode}`);
  if (!container) return;

  // 既存のリスナーを解除するためにdata属性でフラグ管理
  if (container.dataset.dragBound === '1') return;
  container.dataset.dragBound = '1';

  container.addEventListener('mousedown', e => {
    const canvas = document.getElementById(`trim-canvas-${mode}`);
    if (!canvas) return;
    trimDragState[mode].active = true;
    const rect = container.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    trimDragState[mode].startX = (e.clientX - rect.left) * scaleX;
    trimDragState[mode].startY = (e.clientY - rect.top) * scaleY;
    e.preventDefault();
  });

  // タッチ対応
  container.addEventListener('touchstart', e => {
    const canvas = document.getElementById(`trim-canvas-${mode}`);
    if (!canvas) return;
    trimDragState[mode].active = true;
    const rect = container.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    trimDragState[mode].startX = (e.touches[0].clientX - rect.left) * scaleX;
    trimDragState[mode].startY = (e.touches[0].clientY - rect.top) * scaleY;
    e.preventDefault();
  }, { passive: false });

  container.addEventListener('touchmove', e => {
    if (!trimDragState[mode].active) return;
    const canvas2 = document.getElementById(`trim-canvas-${mode}`);
    if (!canvas2) return;
    const rect = container.getBoundingClientRect();
    const scaleX = canvas2.width / rect.width;
    const scaleY = canvas2.height / rect.height;
    const curX = Math.min(canvas2.width, Math.max(0, (e.touches[0].clientX - rect.left) * scaleX));
    const curY = Math.min(canvas2.height, Math.max(0, (e.touches[0].clientY - rect.top) * scaleY));
    const x1 = Math.min(trimDragState[mode].startX, curX), y1 = Math.min(trimDragState[mode].startY, curY);
    const x2 = Math.max(trimDragState[mode].startX, curX), y2 = Math.max(trimDragState[mode].startY, curY);
    applyTrimFromCanvas(mode, x1, y1, x2, y2, canvas2.width, canvas2.height);
    e.preventDefault();
  }, { passive: false });

  container.addEventListener('touchend', () => { trimDragState[mode].active = false; });
}

function applyTrimFromCanvas(mode, x1, y1, x2, y2, cW, cH) {
  // canvas上の選択範囲を0〜1の比率で保存（座標変換は実行時に行う）
  const ratios = {
    x1: x1 / cW,  // 左端の比率
    y1: y1 / cH,  // 上端の比率
    x2: x2 / cW,  // 右端の比率
    y2: y2 / cH,  // 下端の比率
    marginPt: Math.max(0, Number(document.getElementById(`trim-margin-${mode}`).value) || 0),
  };

  if (mode === 'all') {
    trimAllSel = ratios;
  } else {
    trimPerSel[trimPerCurrentPage] = ratios;
    updateTrimPerPageListDots();
    updateTrimPerSummary();
  }

  // 入力欄の表示（参考用：canvasピクセル値）
  const pageNum = mode === 'all' ? trimCurrentPage : trimPerCurrentPage;
  const { width: ptW, height: ptH } = trimPageSizes[pageNum - 1];
  document.getElementById(`trim-left-${mode}`).value   = Math.round(ratios.x1 * ptW);
  document.getElementById(`trim-right-${mode}`).value  = Math.round((1 - ratios.x2) * ptW);
  document.getElementById(`trim-top-${mode}`).value    = Math.round(ratios.y1 * ptH);
  document.getElementById(`trim-bottom-${mode}`).value = Math.round((1 - ratios.y2) * ptH);

  // 選択ボックスをcanvas上に表示
  const sel = document.getElementById(`trim-selection-${mode}`);
  const container = document.getElementById(`trim-canvas-container-${mode}`);
  const rect = container.getBoundingClientRect();
  sel.style.display = 'block';
  sel.style.left   = (ratios.x1 * rect.width) + 'px';
  sel.style.top    = (ratios.y1 * rect.height) + 'px';
  sel.style.width  = ((ratios.x2 - ratios.x1) * rect.width) + 'px';
  sel.style.height = ((ratios.y2 - ratios.y1) * rect.height) + 'px';
}

function updateTrimSelectionBox(mode) {
  const ratios = mode === 'all' ? trimAllSel : trimPerSel[trimPerCurrentPage];
  if (!ratios || ratios.x1 == null) { hideTrimSelection(mode); return; }
  const container = document.getElementById(`trim-canvas-container-${mode}`);
  const rect = container.getBoundingClientRect();
  const box = document.getElementById(`trim-selection-${mode}`);
  box.style.display = 'block';
  box.style.left   = (ratios.x1 * rect.width) + 'px';
  box.style.top    = (ratios.y1 * rect.height) + 'px';
  box.style.width  = ((ratios.x2 - ratios.x1) * rect.width) + 'px';
  box.style.height = ((ratios.y2 - ratios.y1) * rect.height) + 'px';
}

function hideTrimSelection(mode) {
  document.getElementById(`trim-selection-${mode}`).style.display = 'none';
}

function onTrimInputChange(mode) {
  const pageNum = mode === 'all' ? trimCurrentPage : trimPerCurrentPage;
  const { width: ptW, height: ptH } = trimPageSizes[pageNum - 1];
  const left   = Math.max(0, Number(document.getElementById(`trim-left-${mode}`).value) || 0);
  const right  = Math.max(0, Number(document.getElementById(`trim-right-${mode}`).value) || 0);
  const top    = Math.max(0, Number(document.getElementById(`trim-top-${mode}`).value) || 0);
  const bottom = Math.max(0, Number(document.getElementById(`trim-bottom-${mode}`).value) || 0);
  const marginPt = Math.max(0, Number(document.getElementById(`trim-margin-${mode}`).value) || 0);
  if (left + right >= ptW || top + bottom >= ptH) {
    setStatus('trim', msg('入力値がページサイズ以上です。残す範囲を指定してください。', 'The trim values leave no page area. Enter smaller values.'), true);
    document.getElementById('trim-btn').disabled = true;
    return;
  }
  const ratios = {
    x1: left / ptW,
    y1: top / ptH,
    x2: (ptW - right) / ptW,
    y2: (ptH - bottom) / ptH,
    marginPt,
  };
  if (mode === 'all') {
    trimAllSel = ratios;
  } else {
    trimPerSel[pageNum] = ratios;
    updateTrimPerPageListDots();
    updateTrimPerSummary();
  }
  setStatus('trim', '');
  document.getElementById('trim-btn').disabled = false;
  updateTrimSelectionBox(mode);
}

function resetTrimSelection(mode) {
  ['top','bottom','left','right'].forEach(d => { document.getElementById(`trim-${d}-${mode}`).value = 0; });
  document.getElementById(`trim-margin-${mode}`).value = 0;
  if (mode === 'all') {
    trimAllSel = null;
  } else {
    delete trimPerSel[trimPerCurrentPage];
    updateTrimPerPageListDots();
    updateTrimPerSummary();
  }
  setStatus('trim', '');
  document.getElementById('trim-btn').disabled = !trimBytes;
  hideTrimSelection(mode);
}

function clearAllTrimSettings() {
  trimPerSel = {};
  updateTrimPerPageListDots();
  updateTrimPerSummary();
  hideTrimSelection('per');
  ['top','bottom','left','right'].forEach(d => { document.getElementById(`trim-${d}-per`).value = 0; });
  document.getElementById('trim-margin-per').value = 0;
}

function applyTrimToAll() {
  const pageNum = trimPerCurrentPage;
  const r = trimPerSel[pageNum];
  if (!r) return;
  for (let i = 1; i <= trimPageCount; i++) trimPerSel[i] = { ...r };
  updateTrimPerPageListDots();
  updateTrimPerSummary();
}

function updateTrimPerPageListDots() {
  for (let i = 1; i <= trimPageCount; i++) {
    const item = document.getElementById(`trim-per-item-${i}`);
    if (!item) continue;
    const r = trimPerSel[i];
    const hasTrim = r && r.x1 != null && (r.x1 > 0 || r.y1 > 0 || r.x2 < 1 || r.y2 < 1);
    item.classList.toggle('has-trim', !!hasTrim);
  }
}

function updateTrimPerSummary() {
  const summary = document.getElementById('trim-per-summary');
  const pages = Object.keys(trimPerSel).filter(p => {
    const r = trimPerSel[p];
    return r && r.x1 != null && (r.x1 > 0 || r.y1 > 0 || r.x2 < 1 || r.y2 < 1);
  }).map(Number).sort((a,b) => a-b);
  if (pages.length === 0) { summary.innerHTML = ''; return; }
  summary.innerHTML = pages.map(p => `<span class="trim-per-chip">P${p}</span>`).join('');
}

function setTrimMode(mode) {
  trimMode = mode;
  document.getElementById('trim-mode-all').classList.toggle('active', mode === 'all');
  document.getElementById('trim-mode-per').classList.toggle('active', mode === 'per');
  document.getElementById('trim-mode-all').setAttribute('aria-pressed', String(mode === 'all'));
  document.getElementById('trim-mode-per').setAttribute('aria-pressed', String(mode === 'per'));
  document.getElementById('trim-all-section').classList.toggle('hidden', mode !== 'all');
  document.getElementById('trim-per-section').classList.toggle('hidden', mode !== 'per');
}

// ===== トリミング実行 =====
async function executeTrim() {
  if (!trimBytes) return;
  const btn = document.getElementById('trim-btn');
  const prog = document.getElementById('trim-progress');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${msg('処理中…', 'Processing…')}`;
  setStatus('trim', '');
  prog.classList.add('active');

  try {
    const srcDoc = await PDFDocument.load(trimBytes);
    const outDoc = await PDFDocument.create();

    for (let i = 0; i < trimPageCount; i++) {
      setProgressBar(prog, ((i + 1) / trimPageCount) * 100);
      const [copiedPage] = await outDoc.copyPages(srcDoc, [i]);

      let ratios = trimMode === 'all' ? trimAllSel : trimPerSel[i + 1];
      if (!ratios || ratios.x1 == null) { outDoc.addPage(copiedPage); await sleep(10); continue; }

      // MediaBoxの生サイズ（rotation未適用）
      const mb = copiedPage.getMediaBox();
      const mbW = mb.width, mbH = mb.height;
      // rotationを取得
      const rotAngle = copiedPage.getRotation().angle; // 0,90,180,270

      // canvas比率(x1,y1,x2,y2) → MediaBox座標(cropX,cropY,cropW,cropH)
      // canvasは rotation 適用済みで表示されているので逆回転してMediaBox座標に変換
      // PDF座標系: 左下原点、Y軸上向き
      let cropX, cropY, cropW, cropH;
      const displaySize = trimPageSizes[i];
      const marginPt = Math.max(0, Number(ratios.marginPt) || 0);
      const rx1 = Math.max(0, ratios.x1 - marginPt / displaySize.width);
      const ry1 = Math.max(0, ratios.y1 - marginPt / displaySize.height);
      const rx2 = Math.min(1, ratios.x2 + marginPt / displaySize.width);
      const ry2 = Math.min(1, ratios.y2 + marginPt / displaySize.height);

      if (rotAngle === 0) {
        cropX = rx1 * mbW;
        cropY = (1 - ry2) * mbH;
        cropW = (rx2 - rx1) * mbW;
        cropH = (ry2 - ry1) * mbH;
      } else if (rotAngle === 90) {
        // canvas x→MediaBox Y(上), canvas y→MediaBox X(左)
        cropX = ry1 * mbW;
        cropY = rx1 * mbH;
        cropW = (ry2 - ry1) * mbW;
        cropH = (rx2 - rx1) * mbH;
      } else if (rotAngle === 180) {
        cropX = (1 - rx2) * mbW;
        cropY = ry1 * mbH;
        cropW = (rx2 - rx1) * mbW;
        cropH = (ry2 - ry1) * mbH;
      } else if (rotAngle === 270) {
        // canvas x→MediaBox Y(下から), canvas y→MediaBox X(右から)
        cropX = (1 - ry2) * mbW;
        cropY = (1 - rx2) * mbH;
        cropW = (ry2 - ry1) * mbW;
        cropH = (rx2 - rx1) * mbH;
      }

      if (cropW > 0 && cropH > 0) {
        copiedPage.setCropBox(cropX, cropY, cropW, cropH);
        copiedPage.setMediaBox(cropX, cropY, cropW, cropH);
        copiedPage.setBleedBox(cropX, cropY, cropW, cropH);
        copiedPage.setTrimBox(cropX, cropY, cropW, cropH);
        copiedPage.setArtBox(cropX, cropY, cropW, cropH);
      }
      outDoc.addPage(copiedPage);
      await sleep(10);
    }

    const outBytes = await outDoc.save();
    downloadBlob(outBytes, `${trimFileName}_trimmed.pdf`);
    setStatus('trim', msg(`✓ トリミング完了（${trimPageCount}ページ）`, `✓ Trimmed ${trimPageCount} page${trimPageCount === 1 ? '' : 's'}`));
  } catch(e) {
    console.error(e);
    setStatus('trim', `${msg('エラー: ', 'Error: ')}${humanError(e)}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = msg('✂ トリミングしてダウンロード', '✂ Trim & Download');
    setTimeout(() => prog.classList.remove('active'), 800);
  }
}

async function resetTrim() {
  if (trimPdfTask) await trimPdfTask.destroy().catch(() => {});
  trimFile = null; trimBytes = null; trimPdfDoc = null; trimPdfTask = null;
  trimPageCount = 0; trimPageSizes = [];
  trimAllSel = null;
  trimPerSel = {};
  trimCurrentPage = 1; trimPerCurrentPage = 1;
  document.getElementById('trim-file-info').innerHTML = '';
  document.getElementById('trim-controls').classList.add('hidden');
  setStatus('trim', '');
  document.getElementById('trim-file-input').value = '';
  document.getElementById('trim-btn').disabled = true;
  hideTrimSelection('all');
  hideTrimSelection('per');
  ['top','bottom','left','right'].forEach(d => {
    document.getElementById(`trim-${d}-all`).value = 0;
    document.getElementById(`trim-${d}-per`).value = 0;
  });
  document.getElementById('trim-margin-all').value = 0;
  document.getElementById('trim-margin-per').value = 0;
  setTrimMode('all');
}

// ===== ACTIONS & ACCESSIBILITY =====
const ACTIONS = Object.freeze({
  switchTab,
  executeSplit, resetSplit,
  executeMerge, resetMerge, removeMergeFile, moveMergeFile,
  extractSelectAll, extractDeselectAll, executeExtract, resetExtract,
  rotateAllPages, rotatePage, executeRotate, resetRotate,
  reverseReorder, resetReorderOrder, moveReorderPage, executeReorder, resetReorder,
  executeCompress, resetCompress,
  setTrimMode, trimNavPage, selectTrimPerPage, onTrimInputChange,
  resetTrimSelection, applyTrimToAll, clearAllTrimSettings, executeTrim, resetTrim,
});

function scopeForAction(action) {
  const lowered = action.toLowerCase();
  return ['split', 'merge', 'extract', 'rotate', 'reorder', 'compress', 'trim'].find(scope => lowered.includes(scope));
}

function restoreActionButton(scope) {
  const button = document.getElementById(`${scope}-btn`);
  if (!button) return;
  const disabled = {
    split: splitPoints.size === 0,
    merge: mergeFiles.length < 2,
    extract: extractSelected.size === 0,
    rotate: rotateAngles.length === 0 || rotateAngles.every(angle => angle === 0),
    reorder: !reorderBytes,
    compress: !compressFile,
    trim: !trimBytes,
  }[scope];
  button.disabled = Boolean(disabled);
}

async function runAction(element, action, argsText) {
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`Unknown action: ${action}`);
  const args = argsText ? JSON.parse(argsText) : [];
  element.setAttribute('aria-busy', 'true');
  try {
    await handler(...args);
  } catch (error) {
    console.error(error);
    const scope = scopeForAction(action);
    if (scope) {
      setStatus(scope, `${msg('エラー: ', 'Error: ')}${humanError(error)}`, true);
      restoreActionButton(scope);
      document.getElementById(`${scope}-progress`)?.classList.remove('active');
    }
  } finally {
    element.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  event.preventDefault();
  void runAction(element, element.dataset.action, element.dataset.actionArgs);
});

document.addEventListener('input', event => {
  const element = event.target.closest('[data-input-action]');
  if (!element) return;
  void runAction(element, element.dataset.inputAction, element.dataset.actionArgs);
});

document.querySelectorAll('button:not([type])').forEach(button => { button.type = 'button'; });
document.querySelectorAll('.tab').forEach((tab, index, tabs) => {
  const name = tab.dataset.tab;
  tab.id = `tab-${name}`;
  tab.setAttribute('aria-controls', `panel-${name}`);
  tab.addEventListener('keydown', event => {
    const keyMap = { ArrowRight: 1, ArrowLeft: -1 };
    let targetIndex = keyMap[event.key] == null ? index : (index + keyMap[event.key] + tabs.length) % tabs.length;
    if (event.key === 'Home') targetIndex = 0;
    if (event.key === 'End') targetIndex = tabs.length - 1;
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = tabs[targetIndex];
    switchTab(next.dataset.tab);
    next.focus();
  });
});
document.querySelectorAll('.panel').forEach(panel => {
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${panel.id.replace('panel-', '')}`);
});
document.querySelectorAll('.drop-zone input[type="file"]').forEach(input => {
  const drop = input.closest('.drop-zone');
  input.setAttribute('aria-label', `${drop.querySelector('.label')?.textContent || ''} ${drop.querySelector('.sub')?.textContent || ''}`.trim());
});
document.querySelectorAll('.trim-input-group input').forEach(input => {
  const label = input.closest('.trim-input-group')?.querySelector('label')?.textContent;
  if (label) input.setAttribute('aria-label', label);
});
document.querySelectorAll('.status').forEach(status => {
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
});
document.querySelectorAll('.progress-bar').forEach(progress => {
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', '0');
});
document.getElementById('compress-progress-wrap').setAttribute('role', 'progressbar');
document.getElementById('compress-progress-wrap').setAttribute('aria-valuemin', '0');
document.getElementById('compress-progress-wrap').setAttribute('aria-valuemax', '100');
document.getElementById('compress-progress-wrap').setAttribute('aria-valuenow', '0');
switchTab('split');
