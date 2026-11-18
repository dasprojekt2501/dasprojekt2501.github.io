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
  maxTotalCanvasPixels: 4_500_000_000, // 500ページのA4を300DPIで処理できる上限（1ページ毎のcanvasは都度解放される）
  maxRedactRegions: 1000,
});
// 圧縮タブの解像度スライダー（HTML側のmin/max/stepと一致させること）
const COMPRESS_DPI = Object.freeze({ min: 72, max: 300, step: 6, base: 150 });
// Safariなど一部のブラウザはcanvasのfilterに未対応で、ぼかしを出力へ適用できない。
// UA判定ではなく実際にfilterが効くか試すため、将来対応された環境では自動的に有効へ戻る。
const CANVAS_BLUR_SUPPORTED = (() => {
  try {
    const context = document.createElement('canvas').getContext('2d');
    if (!context || !('filter' in context)) return false;
    context.filter = 'blur(2px)';
    return context.filter === 'blur(2px)';
  } catch {
    return false;
  }
})();
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

// ブラウザは、タブが非表示の間（別のタブを表示中・最小化中・ウィンドウが完全に隠れている間）
// requestAnimationFrameを一切呼ばず、setTimeoutも1秒に1回まで間引く。
// MessageChannelのメッセージは間引かれないので、長い処理の「続き」はこちらで予約する。
const backgroundTasks = (() => {
  const channel = new MessageChannel();
  const queue = new Map();
  let nextId = -1; // requestAnimationFrameのIDは正の整数なので、負の番号で区別する
  channel.port1.onmessage = ({ data }) => {
    const callback = queue.get(data);
    if (!callback) return;
    queue.delete(data);
    callback(performance.now());
  };
  return {
    schedule(callback) {
      const id = nextId--;
      queue.set(id, callback);
      channel.port2.postMessage(id);
      return id;
    },
    cancel(id) { return queue.delete(id); },
  };
})();

// ほかの処理（画面の更新や入力）に順番を譲る。sleep(0)と違い、タブが非表示でも待たされない。
function nextTask() {
  return new Promise(resolve => backgroundTasks.schedule(resolve));
}

// pdf.jsは描画の続きをrequestAnimationFrameで予約する（画面表示用の描画では切り替える手段がない）。
// そのままではタブが非表示の間は1ページも描けず、処理が止まったように見えていた。
// 出力用の描画の間だけ、非表示でも止まらない予約に差し替える。pdf.jsは予約のたびに
// windowから関数を引くので、差し替えは実行中の描画にもそのまま効く。
const nativeFrames = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
let backgroundFrameUsers = 0;
async function withBackgroundFrames(render) {
  if (backgroundFrameUsers++ === 0) {
    window.requestAnimationFrame = callback => backgroundTasks.schedule(callback);
    window.cancelAnimationFrame = id => {
      if (!backgroundTasks.cancel(id)) nativeFrames.cancel.call(window, id);
    };
  }
  try {
    return await render();
  } finally {
    if (--backgroundFrameUsers === 0) {
      window.requestAnimationFrame = nativeFrames.request;
      window.cancelAnimationFrame = nativeFrames.cancel;
    }
  }
}

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

// 処理中のタブでは新しいファイルの読み込みとリセットをブロックする
// （実行中の関数はさらに開始時点の状態スナップショットを使い、途中のUI操作から出力を守る）
const processingScopes = new Set();
function beginProcessing(scope) {
  processingScopes.add(scope);
  const input = document.getElementById(`${scope}-file-input`);
  if (input) input.disabled = true;
}
function endProcessing(scope) {
  processingScopes.delete(scope);
  const input = document.getElementById(`${scope}-file-input`);
  if (input) input.disabled = false;
}
function ensureNotProcessing(scope) {
  if (processingScopes.has(scope)) {
    throw new Error(msg('現在の処理が完了してから別のPDFを選択してください。', 'Wait for the current process to finish before selecting another PDF.'));
  }
}
function refuseResetWhileProcessing(scope) {
  if (!processingScopes.has(scope)) return false;
  setStatus(scope, msg('現在の処理が完了するまでお待ちください。', 'Wait for the current process to finish.'));
  return true;
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

// ページ寸法から、ensureCanvasSizeの上限を超えずに全ページを描ける最大DPIを求める。
// 72 DPIでも描けない場合は0を返す。自動設定はここを参照せずにDPIを提案していたため、
// 大きな判型（A2/A1など）では設定完了後に実行時エラーになっていた。
function maxRenderDpi(pageSizes) {
  for (let dpi = COMPRESS_DPI.max; dpi >= COMPRESS_DPI.min; dpi -= COMPRESS_DPI.step) {
    const scale = dpi / 72;
    let total = 0;
    let fits = true;
    for (const { width, height } of pageSizes) {
      const pixels = Math.ceil(width * scale) * Math.ceil(height * scale);
      if (pixels > LIMITS.maxCanvasPixels) { fits = false; break; }
      total += pixels;
    }
    if (fits && total <= LIMITS.maxTotalCanvasPixels) return dpi;
  }
  return 0;
}

function pdfJsOptions(data) {
  const source = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return {
    data: source,
    isEvalSupported: false,
    // stopAtErrorsは付けない。trueにすると、ページ内に不備が1つでもあるだけで
    // そのページの描画命令リスト全体が破棄され、例外も出ないまま白紙が返る。
    // プレビューは理由なく真っ白になり、圧縮は白紙のPDFを「成功」として出力してしまう。
    // 実際の防御は isEvalSupported / enableXfa / maxImageSize / CSP が担っている。
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
  ensureNotProcessing('split');
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
  const bytes = splitBytes, pageCount = splitPageCount, fileName = splitFileName;
  const sorted = [...splitPoints].sort((a,b) => a-b);
  if (!bytes || sorted.length === 0) return;
  const btn = document.getElementById('split-btn'), prog = document.getElementById('split-progress');
  beginProcessing('split');
  btn.disabled = true; setStatus('split', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 0);
  try {
    const ranges = []; let s = 0;
    for (const sp of sorted) { ranges.push([s, sp-1]); s = sp; }
    ranges.push([s, pageCount-1]);
    for (let i = 0; i < ranges.length; i++) {
      setProgressBar(prog, ((i+1)/ranges.length)*100);
      const src = await PDFDocument.load(bytes);
      const np = await PDFDocument.create();
      const idx = []; for (let p = ranges[i][0]; p <= ranges[i][1]; p++) idx.push(p);
      (await np.copyPages(src, idx)).forEach(pg => np.addPage(pg));
      downloadBlob(await np.save(), `${fileName}_p${ranges[i][0]+1}-${ranges[i][1]+1}.pdf`);
      await sleep(300);
    }
    setStatus('split', msg(`✓ ${ranges.length}ファイルをダウンロードしました`, `✓ Downloaded ${ranges.length} file${ranges.length === 1 ? '' : 's'}`)); btn.disabled = false;
  } finally {
    endProcessing('split');
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetSplit() {
  if (refuseResetWhileProcessing('split')) return;
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
  ensureNotProcessing('merge');
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
  const files = mergeFiles.slice();
  if (files.length < 2) return;
  const btn = document.getElementById('merge-btn'), prog = document.getElementById('merge-progress');
  beginProcessing('merge');
  btn.disabled = true; setStatus('merge', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 0);
  try {
    const merged = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      setProgressBar(prog, ((i+1)/files.length)*100);
      const src = await PDFDocument.load(files[i].bytes);
      (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
      await sleep(100);
    }
    downloadBlob(await merged.save(), `${baseName(files[0].name)}_merged.pdf`);
    const tp = files.reduce((s, f) => s + f.pageCount, 0);
    setStatus('merge', msg(`✓ ${files.length}ファイル（計${tp}ページ）を結合しました`, `✓ Merged ${files.length} files (${tp} pages)`)); btn.disabled = false;
  } finally {
    endProcessing('merge');
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetMerge() {
  if (refuseResetWhileProcessing('merge')) return;
  mergeFiles = []; mergeIdCtr = 0; renderMergeList(); setStatus('merge', ''); document.getElementById('merge-file-input').value = '';
}

// ===== EXTRACT =====
let extractBytes = null, extractPageCount = 0, extractSelected = new Set(), extractFileName = '';
setupDrop('extract-drop', 'extract-file-input', loadExtractFile);

async function loadExtractFile(file) {
  ensureNotProcessing('extract');
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
  const bytes = extractBytes, fileName = extractFileName;
  const sorted = [...extractSelected].sort((a, b) => a - b);
  if (!bytes || sorted.length === 0) return;
  const btn = document.getElementById('extract-btn'), prog = document.getElementById('extract-progress');
  beginProcessing('extract');
  btn.disabled = true; setStatus('extract', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 50);
  try {
    const src = await PDFDocument.load(bytes);
    const np = await PDFDocument.create();
    (await np.copyPages(src, sorted.map(p => p - 1))).forEach(pg => np.addPage(pg));
    const extName = sorted.length <= 4
      ? `${fileName}_extracted_p${sorted.join('_p')}.pdf`
      : `${fileName}_extracted_${sorted.length}pages.pdf`;
    downloadBlob(await np.save(), extName);
    setProgressBar(prog, 100);
    setStatus('extract', msg(`✓ ${sorted.length}ページを抽出しました`, `✓ Extracted ${sorted.length} page${sorted.length === 1 ? '' : 's'}`)); btn.disabled = false;
  } finally {
    endProcessing('extract');
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetExtract() {
  if (refuseResetWhileProcessing('extract')) return;
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
  ensureNotProcessing('rotate');
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
  const bytes = rotateBytes, fileName = rotateFileName, angles = rotateAngles.slice();
  if (!bytes || angles.every(a => a === 0)) return;
  const btn = document.getElementById('rotate-btn'), prog = document.getElementById('rotate-progress');
  beginProcessing('rotate');
  btn.disabled = true; setStatus('rotate', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 50);
  try {
    const pdf = await PDFDocument.load(bytes);
    for (let i = 0; i < angles.length; i++) {
      if (angles[i] !== 0) {
        const page = pdf.getPage(i);
        const cur = page.getRotation().angle;
        // 元PDFの/Rotateは負の値もありうるため0〜270へ正規化する
        page.setRotation(degrees(((cur + angles[i]) % 360 + 360) % 360));
      }
    }
    downloadBlob(await pdf.save(), `${fileName}_rotated.pdf`);
    setProgressBar(prog, 100);
    const changed = angles.filter(a => a !== 0).length;
    setStatus('rotate', msg(`✓ ${changed}ページを回転しました`, `✓ Rotated ${changed} page${changed === 1 ? '' : 's'}`)); btn.disabled = false;
  } finally {
    endProcessing('rotate');
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetRotate() {
  if (refuseResetWhileProcessing('rotate')) return;
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
  ensureNotProcessing('reorder');
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
  const bytes = reorderBytes, order = reorderOrder.slice(), fileName = reorderFileName;
  if (!bytes || order.length === 0) return;
  const btn = document.getElementById('reorder-btn'), prog = document.getElementById('reorder-progress');
  beginProcessing('reorder');
  btn.disabled = true; setStatus('reorder', msg('処理中…', 'Processing…')); prog.classList.add('active'); setProgressBar(prog, 35);
  try {
    const src = await PDFDocument.load(bytes);
    const np = await PDFDocument.create();
    (await np.copyPages(src, order)).forEach(pg => np.addPage(pg));
    setProgressBar(prog, 85);
    downloadBlob(await np.save(), `${fileName}_reordered.pdf`);
    setProgressBar(prog, 100);
    setStatus('reorder', msg('✓ 並べ替えたPDFをダウンロードしました', '✓ Downloaded the reordered PDF'));
  } finally {
    endProcessing('reorder');
    btn.disabled = false;
    setTimeout(() => prog.classList.remove('active'), 1000);
  }
}
function resetReorder() {
  if (refuseResetWhileProcessing('reorder')) return;
  reorderBytes = null; reorderPageCount = 0; reorderOrder = [];
  document.getElementById('reorder-file-info').innerHTML = '';
  document.getElementById('reorder-controls').classList.add('hidden');
  setStatus('reorder', '');
  document.getElementById('reorder-file-input').value = '';
}

// ===== COMPRESS =====
let compressFile = null, compressedBytes = null, compressedName = '', compressGeneration = 0;
// 直近の自動設定の結果。同じファイルなら、圧縮の実行時にページ寸法と見積もりを使い回す。
let compressPlan = null;
// 進行中の自動設定。圧縮ボタンはこの最中でも押せ、完了を待ってから実行する。
// 以前は自動設定中にボタンを無効化していたため、目標サイズを書き換えた直後のクリックが
// （入力欄のchange → 再計測 → 無効化 が先に走って）握りつぶされていた。
let compressCalibration = null;

// 自動設定のふるまい
const COMPRESS_AUTO = Object.freeze({
  margin: 0.95,             // 見積もり誤差の余裕として、目標の95%に収まる設定を選ぶ
  minQuality: 30,           // 自動設定が選ぶ品質の下限（手動ではスライダーで10まで下げられる）
  maxQuality: 95,
  samplePages: 5,           // 見積もりに使うページ数
  samplePixels: 50_000_000, // 品質の探索中に保持するサンプルcanvasの合計画素数の上限
  maxAttempts: 4,           // 目標を超えたときに設定を下げてやり直す回数の上限
});

// Slider listeners
document.getElementById('compress-quality').addEventListener('input', function() {
  document.getElementById('compress-quality-val').textContent = this.value + '%';
});
document.getElementById('compress-dpi').addEventListener('input', function() {
  document.getElementById('compress-dpi-val').textContent = this.value + ' DPI';
});
document.getElementById('compress-target').addEventListener('change', function() {
  if (compressFile && !processingScopes.has('compress')) void startCompressCalibration(compressFile);
});

setupDrop('compress-drop', 'compress-file-input', loadCompressFile);

async function loadCompressFile(file) {
  ensureNotProcessing('compress');
  compressFile = file;
  compressedBytes = null;
  compressedName = '';
  compressPlan = null;
  showFileInfo('compress-file-info', file.name, null, file.size, 'resetCompress');
  document.getElementById('compress-btn').disabled = false;
  document.getElementById('compress-result').style.display = 'none';
  document.getElementById('compress-progress-wrap').style.display = 'none';
  setStatus('compress', '');
  document.getElementById('quality-badge').style.display = 'none';
  document.getElementById('dpi-badge').style.display = 'none';
  document.getElementById('compress-dpi').max = String(COMPRESS_DPI.max);
  await startCompressCalibration(file);
}

function startCompressCalibration(file) {
  const run = calibrateCompress(file).finally(() => {
    if (compressCalibration === run) compressCalibration = null;
  });
  compressCalibration = run;
  return run;
}

function abortIfStale(generation, file) {
  if (generation !== compressGeneration || file !== compressFile) {
    throw new DOMException('A newer compression request replaced this one.', 'AbortError');
  }
}

function canvasToJpeg(canvas, quality) {
  const failure = () => new Error(msg('ページ画像を作成できませんでした。', 'Could not create the page image.'));
  // タブが非表示になって10秒ほど経つと、ブラウザはtoBlobを1回あたり1秒以上待たせる
  // （Chromeでの実測: A4・300 DPIで約1.1秒。表示中は約0.04秒）。
  // 非表示の間は、待たされない同期のtoDataURLで同じJPEGを作る。
  if (document.hidden) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const prefix = 'data:image/jpeg;base64,';
    if (!dataUrl.startsWith(prefix)) return Promise.reject(failure());
    const binary = atob(dataUrl.slice(prefix.length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Promise.resolve(bytes);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(failure());
        return;
      }
      blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }, 'image/jpeg', quality);
  });
}

// 描画結果が真っ白かどうかを縮小サンプルで判定する。
// 描画に失敗したページが黙って白紙のまま出力されないよう、圧縮結果の警告に使う。
const BLANK_PROBE_SIZE = 128;
function isRenderBlank(canvas) {
  const probe = document.createElement('canvas');
  probe.width = BLANK_PROBE_SIZE;
  probe.height = BLANK_PROBE_SIZE;
  try {
    const context = probe.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) return false;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE);
    context.drawImage(canvas, 0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE);
    const { data } = context.getImageData(0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    probe.width = 0;
    probe.height = 0;
  }
}

// 1ページを指定DPIでcanvasへ描画する。使い終わったら呼び出し側が release() でcanvasを解放すること。
async function renderPageToCanvas(pdfDoc, pageNumber, dpi, runningTotal = 0) {
  const page = await pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: dpi / 72 });
  const nextTotal = ensureCanvasSize(viewport, runningTotal);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const release = () => {
    canvas.width = 0;
    canvas.height = 0;
  };
  try {
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await withBackgroundFrames(() => page.render({ canvasContext: context, viewport }).promise);
  } catch (error) {
    release();
    throw error;
  } finally {
    page.cleanup();
  }
  return { canvas, release, width: baseViewport.width, height: baseViewport.height, runningTotal: nextTotal };
}

async function renderPageToJpeg(pdfDoc, pageNumber, dpi, quality, runningTotal = 0) {
  const rendered = await renderPageToCanvas(pdfDoc, pageNumber, dpi, runningTotal);
  try {
    return {
      bytes: await canvasToJpeg(rendered.canvas, quality),
      blank: isRenderBlank(rendered.canvas),
      width: rendered.width,
      height: rendered.height,
      runningTotal: rendered.runningTotal,
    };
  } finally {
    rendered.release();
  }
}

function showCompressSettings(quality, dpi) {
  document.getElementById('compress-quality').value = quality;
  document.getElementById('compress-quality-val').textContent = quality + '%';
  document.getElementById('compress-dpi').value = dpi;
  document.getElementById('compress-dpi-val').textContent = dpi + ' DPI';
}

// 自動設定が狙うサイズ。目標と「元の95%」の小さい方に、見積もり誤差の余裕を掛ける。
function compressAimBytes(requestedBytes, originalSize) {
  return Math.max(1, Math.min(requestedBytes, originalSize * 0.95)) * COMPRESS_AUTO.margin;
}

// 全ページの寸法と、上限を超えずに描画できる最大DPIを調べる。
async function readCompressGeometry(pdfDoc, checkAbort) {
  const pageSizes = [];
  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    checkAbort();
    const viewport = (await pdfDoc.getPage(pageNumber)).getViewport({ scale: 1 });
    pageSizes.push({ width: viewport.width, height: viewport.height });
  }
  const safeDpi = maxRenderDpi(pageSizes);
  if (!safeDpi) {
    throw new Error(msg('ページサイズが大きすぎるため、このPDFは圧縮できません。', 'The pages are too large for this PDF to be compressed.'));
  }
  const totalArea = pageSizes.reduce((sum, size) => sum + size.width * size.height, 0);
  return { pageSizes, safeDpi, totalArea };
}

// 見積もりに使うページを文書全体へ均等に散らして選ぶ。
// 以前の「先頭・中央・末尾」は、表紙や奥付のように他と性質の違うページに引きずられやすかった。
function pickCompressSamples(geometry) {
  const { pageSizes, safeDpi } = geometry;
  const scale = Math.min(COMPRESS_DPI.base, safeDpi) / 72;
  const largestPage = Math.max(...pageSizes.map(({ width, height }) => Math.ceil(width * scale) * Math.ceil(height * scale)));
  // 大判ページではサンプルcanvasの保持量が膨らむため、枚数を減らす（最低1ページ）
  const affordable = Math.max(1, Math.floor(COMPRESS_AUTO.samplePixels / Math.max(1, largestPage)));
  const count = Math.min(COMPRESS_AUTO.samplePages, pageSizes.length, affordable);
  return Array.from({ length: count }, (_, index) => Math.ceil((index + 0.5) * pageSizes.length / count));
}

// サンプルのJPEG合計から文書全体の出力サイズを見積もる関数を返す。
// ページ寸法が混在していても偏らないよう、ページ数ではなく面積で比例させる。
function compressSizeEstimator(geometry, samplePages) {
  const { pageSizes, totalArea } = geometry;
  const sampleArea = samplePages.reduce((sum, pageNumber) => {
    const { width, height } = pageSizes[pageNumber - 1];
    return sum + width * height;
  }, 0);
  const overhead = 2048 + pageSizes.length * 300; // ページ辞書など、画像以外の出力ぶん
  return sampleBytes => sampleBytes * totalArea / Math.max(1, sampleArea) + overhead;
}

// サンプルページを1枚ずつ描画→JPEG化→解放し、合計バイト数を返す（canvasを溜め込まない）。
async function measureCompressSamples(pdfDoc, samplePages, dpi, quality, checkAbort) {
  let total = 0;
  let runningTotal = 0;
  for (const pageNumber of samplePages) {
    checkAbort();
    const rendered = await renderPageToJpeg(pdfDoc, pageNumber, dpi, quality / 100, runningTotal);
    runningTotal = rendered.runningTotal;
    total += rendered.bytes.length;
  }
  return total;
}

// 指定の設定で圧縮した場合の出力サイズを、サンプルページの実測から見積もる。
async function estimateCompressSize({ pdfDoc, geometry, quality, dpi, checkAbort }) {
  const samplePages = pickCompressSamples(geometry);
  const estimate = compressSizeEstimator(geometry, samplePages);
  return estimate(await measureCompressSamples(pdfDoc, samplePages, dpi, quality, checkAbort));
}

// 出力が budgetBytes に収まる見込みの（品質, DPI）を求める。
// 以前はサンプルを150 DPIで2回だけ測り、ほかのDPI・品質には計算で当てはめていた。
// JPEGのサイズは品質にもDPIにも素直に比例しないので、DPIを上げる側では目標を2〜4割超え、
// 品質を下げる側では必要以上に下げていた。ここでは候補の設定でサンプルを実際に
// 描画・JPEG化して確かめる。選び方の方針は従来どおり:
//   1. 品質95のまま、収まる範囲でDPIを上げる
//   2. 基準DPIで品質95が収まらなければ、基準DPIのまま品質を下げる
//   3. 品質の下限でも収まらなければ、下限の品質のままDPIを下げる
// 3でも収まらない場合は、下限の設定と feasible: false を返す。
async function solveCompressSettings({ pdfDoc, geometry, budgetBytes, checkAbort }) {
  const { minQuality, maxQuality } = COMPRESS_AUTO;
  const { min: minDpi, step } = COMPRESS_DPI;
  const baseDpi = Math.min(COMPRESS_DPI.base, geometry.safeDpi);
  const samplePages = pickCompressSamples(geometry);
  const estimate = compressSizeEstimator(geometry, samplePages);
  const fits = bytes => bytes <= budgetBytes;
  const snapDown = dpi => minDpi + Math.floor((dpi - minDpi) / step) * step;
  const measureAt = async (dpi, quality) => estimate(await measureCompressSamples(pdfDoc, samplePages, dpi, quality, checkAbort));

  // 品質を固定し、収まる最大のDPIを実測で探す。
  // fitting / tooBig は「収まる」「収まらない」と分かっている実測点（無ければnull）。
  const searchDpi = async (quality, fitting, tooBig, highestDpi) => {
    let exponent = 2; // サイズはおおよそDPIの2乗に比例する。実測が2点そろえば実際の傾きに置き換える
    for (let round = 0; round < 4; round++) {
      const anchor = fitting ?? tooBig;
      const floorDpi = fitting ? fitting.dpi + step : minDpi;
      const ceilDpi = tooBig ? tooBig.dpi - step : highestDpi;
      if (floorDpi > ceilDpi) break;
      const wanted = snapDown(anchor.dpi * Math.pow(budgetBytes / anchor.estimatedBytes, 1 / exponent));
      if (fitting && wanted < floorDpi) break; // もう1段上げる余地はない
      const dpi = Math.max(floorDpi, Math.min(ceilDpi, wanted));
      const measured = { dpi, estimatedBytes: await measureAt(dpi, quality) };
      const slope = Math.log(measured.estimatedBytes / anchor.estimatedBytes) / Math.log(dpi / anchor.dpi);
      if (Number.isFinite(slope)) exponent = Math.min(3.5, Math.max(1, slope));
      if (fits(measured.estimatedBytes)) fitting = measured; else tooBig = measured;
    }
    return { fitting, tooBig };
  };

  // 基準DPIのcanvasは保持し、品質だけを変えて再エンコードする（描画し直すより桁違いに速い）
  const samples = [];
  const releaseSamples = () => { samples.splice(0).forEach(sample => sample.release()); };
  const measureQuality = async quality => {
    let total = 0;
    for (const sample of samples) {
      checkAbort();
      total += (await canvasToJpeg(sample.canvas, quality / 100)).length;
    }
    return estimate(total);
  };

  try {
    let runningTotal = 0;
    for (const pageNumber of samplePages) {
      checkAbort();
      const rendered = await renderPageToCanvas(pdfDoc, pageNumber, baseDpi, runningTotal);
      runningTotal = rendered.runningTotal;
      samples.push(rendered);
    }

    const top = await measureQuality(maxQuality);
    if (fits(top)) {
      releaseSamples();
      const { fitting } = await searchDpi(maxQuality, { dpi: baseDpi, estimatedBytes: top }, null, geometry.safeDpi);
      return { quality: maxQuality, dpi: fitting.dpi, estimatedBytes: fitting.estimatedBytes, feasible: true };
    }

    const bottom = await measureQuality(minQuality);
    if (fits(bottom)) {
      let quality = minQuality;
      let estimatedBytes = bottom;
      let tooHigh = maxQuality;
      while (tooHigh - quality > 1) {
        const middle = Math.floor((quality + tooHigh) / 2);
        const size = await measureQuality(middle);
        if (fits(size)) {
          quality = middle;
          estimatedBytes = size;
        } else {
          tooHigh = middle;
        }
      }
      return { quality, dpi: baseDpi, estimatedBytes, feasible: true };
    }

    releaseSamples();
    let { fitting, tooBig } = await searchDpi(minQuality, null, { dpi: baseDpi, estimatedBytes: bottom }, baseDpi);
    if (!fitting && tooBig.dpi > minDpi) {
      // 探索が下限まで届かなかった場合は、下限そのものを測って決着をつける
      const floor = { dpi: minDpi, estimatedBytes: await measureAt(minDpi, minQuality) };
      if (fits(floor.estimatedBytes)) fitting = floor; else tooBig = floor;
    }
    const chosen = fitting ?? tooBig;
    return { quality: minQuality, dpi: chosen.dpi, estimatedBytes: chosen.estimatedBytes, feasible: Boolean(fitting) };
  } finally {
    releaseSamples();
  }
}

async function calibrateCompress(file) {
  const generation = ++compressGeneration;
  const checkAbort = () => abortIfStale(generation, file);
  const calibBar = document.getElementById('calib-bar');
  const calibMsg = document.getElementById('calib-msg');
  const targetMB = parseFloat(document.getElementById('compress-target').value) || 10;
  const requestedBytes = targetMB * 1024 * 1024;
  let loadingTask = null;
  let readable = false;

  compressPlan = null;
  calibBar.className = 'calib-bar';
  calibBar.style.display = 'flex';
  calibMsg.textContent = msg('最適な設定を自動で探しています…', 'Finding safe compression settings…');

  try {
    const arrayBuf = await file.arrayBuffer();
    checkAbort();
    const result = await openPdfJs(arrayBuf);
    loadingTask = result.task;
    const pdfDoc = result.doc;
    const geometry = await readCompressGeometry(pdfDoc, checkAbort);
    readable = true;

    calibMsg.textContent = msg('サンプルページで計測中…', 'Measuring sample pages…');
    const solved = await solveCompressSettings({
      pdfDoc,
      geometry,
      checkAbort,
      budgetBytes: compressAimBytes(requestedBytes, file.size),
    });
    checkAbort();

    // 手動操作でも描画上限を超えられないよう、スライダーの上限も下げる（値より先に設定する）。
    document.getElementById('compress-dpi').max = String(geometry.safeDpi);
    showCompressSettings(solved.quality, solved.dpi);
    document.getElementById('quality-badge').style.display = 'block';
    document.getElementById('dpi-badge').style.display = 'block';
    compressPlan = { file, geometry, quality: solved.quality, dpi: solved.dpi, estimatedBytes: solved.estimatedBytes };

    const expected = formatSize(solved.estimatedBytes);
    const alreadySmall = file.size <= requestedBytes;
    if (!solved.feasible) {
      calibBar.className = 'calib-bar calib-warn';
      calibMsg.textContent = alreadySmall
        ? msg(`⚠ すでに目標以下です（${formatSize(file.size)}）。この方式ではこれ以上小さくできない見込みです`, `⚠ Already under the target (${formatSize(file.size)}). This method is not expected to make it any smaller`)
        : msg(`⚠ 最小の自動設定でも目標に収まらない見込みです（約${expected}）`, `⚠ Even the lowest automatic settings are expected to exceed the target (about ${expected})`);
    } else {
      calibBar.className = 'calib-bar calib-done';
      const lead = alreadySmall
        ? msg(`✓ すでに目標以下です（${formatSize(file.size)}）。さらに小さくする設定にしました`, `✓ Already under the target (${formatSize(file.size)}). Settings chosen to shrink it further`)
        : msg('✓ 自動設定完了', '✓ Automatic settings applied');
      const capped = geometry.safeDpi < COMPRESS_DPI.max
        ? msg(`（ページが大きいため解像度は${geometry.safeDpi} DPIまで）`, ` (large pages cap the resolution at ${geometry.safeDpi} DPI)`)
        : '';
      calibMsg.textContent = `${lead} — ${msg(`圧縮後の見込み 約${expected}`, `expected result about ${expected}`)}${capped}`;
    }

  } catch(e) {
    if (e.name !== 'AbortError') {
      console.error('Calibration error:', e);
      calibBar.className = 'calib-bar calib-error';
      // PDFを開けない・ページが大きすぎる場合は手動設定でも実行できないので、そう案内しない。
      calibMsg.textContent = readable
        ? msg('自動設定に失敗しました。手動設定で実行できます。', 'Automatic settings failed. You can still use manual settings.')
        : msg('このPDFは圧縮できません。', 'This PDF cannot be compressed.');
      setStatus('compress', humanError(e), true);
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

// 途中で打ち切ったパスから、同じ設定で最後まで進めた場合の合計サイズを見積もる。
// 残りのページは「見積もりどおり」と「ここまでと同じ割合で見積もりを超える」の間を取り、
// 半分以上進んでいれば後者とする。先頭の数ページだけが重い文書で設定を下げすぎないための折衷。
function projectCompressSize(actualBytes, fraction, predictedBytes) {
  if (fraction >= 1) return actualBytes;
  const ratio = actualBytes / Math.max(1, predictedBytes * fraction);
  const weight = Math.min(1, fraction / 0.5);
  return actualBytes + predictedBytes * (1 - fraction) * Math.pow(ratio, weight);
}

async function executeCompress() {
  if (!compressFile || processingScopes.has('compress')) return;
  const file = compressFile;
  const btn = document.getElementById('compress-btn');
  const progWrap = document.getElementById('compress-progress-wrap');
  const progFill = document.getElementById('compress-progress-fill');
  const progText = document.getElementById('compress-progress-text');
  const progPct  = document.getElementById('compress-progress-pct');

  beginProcessing('compress');
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
    // 自動設定の途中で押された場合は、その完了を待ってから始める。
    setProgress(0, msg('準備中…', 'Preparing…'));
    while (compressCalibration) {
      setProgress(2, msg('自動設定の完了を待っています…', 'Waiting for automatic settings…'));
      await compressCalibration;
    }
    const generation = ++compressGeneration;
    const checkAbort = () => abortIfStale(generation, file);

    const targetMB = parseFloat(document.getElementById('compress-target').value) || 10;
    const targetBytes = targetMB * 1024 * 1024;
    const rmMeta = document.getElementById('compress-meta').checked;
    let quality = parseInt(document.getElementById('compress-quality').value, 10);
    let dpi = parseInt(document.getElementById('compress-dpi').value, 10);

    const originalArray = await file.arrayBuffer();
    const originalSize = originalArray.byteLength;
    // 結果がこれを超えたら（目標を超えた、または元より小さくならなかった）設定を下げてやり直す。
    const limitBytes = Math.min(targetBytes, originalSize - 1);

    setProgress(5, msg('PDF解析中…', 'Parsing PDF…'));
    const opened = await openPdfJs(originalArray);
    loadingTask = opened.task;
    const pdfDoc = opened.doc;
    const numPages = pdfDoc.numPages;
    const plan = compressPlan?.file === file ? compressPlan : null;
    const geometry = plan?.geometry ?? await readCompressGeometry(pdfDoc, checkAbort);
    // 自動設定に失敗していた場合でも、描画できる上限は超えさせない。
    if (dpi > geometry.safeDpi) {
      dpi = geometry.safeDpi;
      document.getElementById('compress-dpi').max = String(geometry.safeDpi);
      showCompressSettings(quality, dpi);
    }
    const metadata = rmMeta ? null : await pdfDoc.getMetadata().catch(() => null);
    // この設定での出力サイズの見積もり（自動設定のままなら計測済み）。設定を下げるときの補正に使う。
    let predicted = plan && plan.quality === quality && plan.dpi === dpi ? plan.estimatedBytes : null;

    // 全ページを1回通して出力PDFを作る。JPEGの合計が abortAbove を超えた時点で、
    // 最後まで描いても目標に収まらないと確定するので打ち切る（bytes: null を返す）。
    const runPass = async (attempt, abortAbove) => {
      const outDoc = await PDFDocument.create();
      const blankPages = [];
      const retryNote = attempt > 1
        ? `${msg(`設定を下げて再圧縮中（${attempt}回目）`, `Re-compressing with lower settings (attempt ${attempt})`)} — `
        : '';
      let runningTotal = 0;
      let jpegBytes = 0;
      let doneArea = 0;

      for (let i = 1; i <= numPages; i++) {
        checkAbort();
        const pct = 8 + ((i - 1) / numPages) * 82;
        setProgress(pct, `${retryNote}${msg(`レンダリング・構築中… (${i} / ${numPages}ページ)`, `Rendering and building… (${i} / ${numPages} pages)`)}`);
        const rendered = await renderPageToJpeg(pdfDoc, i, dpi, quality / 100, runningTotal);
        runningTotal = rendered.runningTotal;
        jpegBytes += rendered.bytes.length;
        doneArea += rendered.width * rendered.height;
        if (jpegBytes > abortAbove) return { bytes: null, blankPages, jpegBytes, doneArea };
        if (rendered.blank) blankPages.push(i);
        const img = await outDoc.embedJpg(rendered.bytes);
        outDoc.addPage([rendered.width, rendered.height]).drawImage(img, { x: 0, y: 0, width: rendered.width, height: rendered.height });
        await nextTask();
      }

      if (rmMeta) {
        outDoc.setTitle(''); outDoc.setAuthor(''); outDoc.setSubject('');
        outDoc.setKeywords([]); outDoc.setProducer(''); outDoc.setCreator('');
      } else {
        copyCompressionMetadata(outDoc, metadata);
      }

      setProgress(94, msg('PDF出力中…', 'Writing PDF…'));
      await nextTask();
      // pdf-libは既定で50オブジェクトごとにsetTimeoutで一息つく。タブが非表示だとその1回ごとに
      // 1秒待たされる（Chromeでの実測: 500ページで約44秒。表示中は約0.2秒）ため、一息つかずに書き出す。
      const bytes = await outDoc.save({ useObjectStreams: true, objectsPerTick: Infinity });
      return { bytes, blankPages, jpegBytes, doneArea };
    };

    // 目標サイズは上限として扱う。超えた場合は、実際に出たサイズをもとに設定を下げてやり直す。
    // 自動設定の下限に達したとき、または回数の上限に達したときは、その結果を警告付きで出す。
    const isAtFloor = () => quality <= COMPRESS_AUTO.minQuality && dpi <= COMPRESS_DPI.min;
    let pass = null;
    let attempt = 1;
    for (;; attempt++) {
      const finalTry = isAtFloor() || attempt >= COMPRESS_AUTO.maxAttempts;
      pass = await runPass(attempt, finalTry ? Infinity : limitBytes);
      if (pass.bytes && pass.bytes.byteLength <= limitBytes) break;
      if (finalTry) break;

      setProgress(6, msg('目標を超えたため、設定を下げて計測し直しています…', 'Over the target — measuring lower settings…'));
      if (predicted === null) predicted = await estimateCompressSize({ pdfDoc, geometry, quality, dpi, checkAbort });
      const actual = pass.bytes ? pass.bytes.byteLength : pass.jpegBytes;
      const fraction = pass.bytes ? 1 : pass.doneArea / geometry.totalArea;
      const projected = projectCompressSize(actual, fraction, predicted);
      const aimBytes = compressAimBytes(targetBytes, originalSize) * 0.97;
      let next;
      if (quality < COMPRESS_AUTO.minQuality) {
        // 手動で自動設定の下限より低い品質にしている場合は、品質を勝手に上げ直さず、DPIだけを下げる。
        const { min, step } = COMPRESS_DPI;
        const wanted = min + Math.floor((dpi * Math.sqrt(aimBytes / projected) - min) / step) * step;
        next = { quality, dpi: Math.max(min, Math.min(dpi - step, wanted)), estimatedBytes: null };
      } else {
        // 見積もりに対して実際がどれだけ大きかったか。次の設定にも同じだけの外れを見込む。
        const bias = Math.max(1.02, projected / predicted);
        next = await solveCompressSettings({ pdfDoc, geometry, checkAbort, budgetBytes: aimBytes / bias });
      }
      if (next.quality === quality && next.dpi === dpi) {
        // 見積もり上は同じ設定に行き着いた場合でも、必ず一段は下げて進める。
        if (quality > COMPRESS_AUTO.minQuality) next.quality = Math.max(COMPRESS_AUTO.minQuality, quality - 5);
        else next.dpi = Math.max(COMPRESS_DPI.min, dpi - COMPRESS_DPI.step);
        next.estimatedBytes = null;
      }
      quality = next.quality;
      dpi = next.dpi;
      predicted = next.estimatedBytes;
      showCompressSettings(quality, dpi);
    }

    const outBytes = pass.bytes;
    checkAbort();
    setProgress(100, msg('完了！', 'Complete!'));
    compressedBytes = outBytes;
    compressedName = `${baseName(file.name)}_compressed.pdf`;
    compressPlan = { file, geometry, quality, dpi, estimatedBytes: predicted };
    if (attempt > 1) {
      // スライダーは下げた後の設定を示しているので、自動設定の表示も実態に合わせる。
      const calibBar = document.getElementById('calib-bar');
      calibBar.className = 'calib-bar calib-done';
      calibBar.style.display = 'flex';
      document.getElementById('calib-msg').textContent = msg('✓ 実際の出力に合わせて設定を下げました', '✓ Settings lowered to match the actual output');
    }

    const afterSize = outBytes.byteLength;
    const ratio = Math.round((1 - afterSize / originalSize) * 100);
    // 元がすでに目標以下なら「目標に収まらない」は当てはまらない（元のファイルを使えばよい）。
    const overTarget = afterSize > targetBytes && originalSize > targetBytes;
    const notSmaller = afterSize >= originalSize;

    document.getElementById('compress-stat-before').textContent = formatSize(originalSize);
    document.getElementById('compress-stat-after').textContent = formatSize(afterSize);
    document.getElementById('compress-stat-ratio').textContent = (ratio >= 0 ? '-' : '+') + Math.abs(ratio) + '%';

    const warnEl = document.getElementById('compress-warn');
    const warnings = [];
    if (pass.blankPages.length) {
      const shown = pass.blankPages.slice(0, 10).map(page => `P${page}`).join(', ');
      const list = pass.blankPages.length > 10 ? `${shown} …` : shown;
      warnings.push(msg(
        `白紙として出力されたページがあります（${list}）。元のPDFに内容がある場合、そのページの描画に失敗しています。`,
        `Some pages came out blank (${list}). If those pages have content in the original, they failed to render.`,
      ));
    }
    if (notSmaller) {
      warnings.push(msg(
        '元のファイルより小さくできませんでした。文字や図形が中心のPDFや、すでに十分圧縮されているPDFは、各ページを画像に変換するこの方式では小さくなりません。元のファイルをそのままお使いください。',
        'The result is not smaller than the original. PDFs made mostly of text and line art, or ones that are already well compressed, do not shrink with this method, which converts every page to an image. Keep using the original file.',
      ));
    }
    if (overTarget) {
      const size = formatSize(afterSize);
      warnings.push(isAtFloor()
        ? msg(
          `目標 ${targetMB}MB に収まりませんでした（${size}）。自動設定の下限（${COMPRESS_DPI.min} DPI・品質${COMPRESS_AUTO.minQuality}%）まで下げた結果です。「分割」タブでPDFを分け、必要ならそれぞれを圧縮してください。`,
          `The ${targetMB} MB target could not be met (${size}), even at the lowest automatic settings (${COMPRESS_DPI.min} DPI, quality ${COMPRESS_AUTO.minQuality}%). Split the PDF in the Split tab and, if needed, compress each part.`,
        )
        : msg(
          `目標 ${targetMB}MB を超えています（${size}）。自動での再調整が上限回数に達しました。もう一度実行するか、品質またはDPIを下げてください。`,
          `The result exceeds the ${targetMB} MB target (${size}). Automatic readjustment reached its limit; run it again, or lower quality or DPI.`,
        ));
    }
    if (warnings.length) {
      warnEl.style.display = 'block';
      warnEl.textContent = `⚠ ${warnings.join(' ')}`;
    } else {
      warnEl.style.display = 'none';
    }

    document.getElementById('compress-result').style.display = 'block';
    if (overTarget) {
      setStatus('compress', msg('⚠ 目標サイズに収まりませんでした', '⚠ The target size was not met'), true);
    } else if (notSmaller) {
      setStatus('compress', msg('⚠ 元のファイルより小さくなりませんでした', '⚠ The result is not smaller than the original'), true);
    } else if (attempt > 1) {
      setStatus('compress', msg('✓ 圧縮処理が完了しました（目標に収まるよう設定を下げて再圧縮）', '✓ Compression complete (re-compressed with lower settings to meet the target)'));
    } else {
      setStatus('compress', msg('✓ 圧縮処理が完了しました', '✓ Compression complete'));
    }
    setTimeout(() => document.getElementById('compress-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  } catch(err) {
    console.error(err);
    setStatus('compress', `${msg('エラー: ', 'Error: ')}${humanError(err)}`, true);
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => {});
    endProcessing('compress');
    btn.disabled = !compressFile;
    btn.innerHTML = msg('🗜️ 圧縮を実行', '🗜️ Compress PDF');
    setTimeout(() => { progWrap.style.display = 'none'; }, 800);
  }
}

document.getElementById('compress-download-btn').addEventListener('click', () => {
  if (!compressedBytes || !compressedName) return;
  downloadBlob(compressedBytes, compressedName);
});

function resetCompress() {
  if (refuseResetWhileProcessing('compress')) return;
  ++compressGeneration;
  compressFile = null; compressedBytes = null; compressedName = ''; compressPlan = null;
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
  const dpiInput = document.getElementById('compress-dpi');
  dpiInput.max = String(COMPRESS_DPI.max);
  dpiInput.value = COMPRESS_DPI.base;
  document.getElementById('compress-dpi-val').textContent = `${COMPRESS_DPI.base} DPI`;
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
  ensureNotProcessing('trim');
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
  const bytes = trimBytes, pageCount = trimPageCount, fileName = trimFileName, mode = trimMode;
  const allSel = trimAllSel ? { ...trimAllSel } : null;
  const perSel = Object.fromEntries(Object.entries(trimPerSel).map(([page, ratios]) => [page, { ...ratios }]));
  const pageSizes = trimPageSizes.slice();
  const btn = document.getElementById('trim-btn');
  const prog = document.getElementById('trim-progress');
  beginProcessing('trim');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${msg('処理中…', 'Processing…')}`;
  setStatus('trim', '');
  prog.classList.add('active');

  try {
    const srcDoc = await PDFDocument.load(bytes);
    const outDoc = await PDFDocument.create();

    for (let i = 0; i < pageCount; i++) {
      setProgressBar(prog, ((i + 1) / pageCount) * 100);
      const [copiedPage] = await outDoc.copyPages(srcDoc, [i]);

      let ratios = mode === 'all' ? allSel : perSel[i + 1];
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
      const displaySize = pageSizes[i];
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
    downloadBlob(outBytes, `${fileName}_trimmed.pdf`);
    setStatus('trim', msg(`✓ トリミング完了（${pageCount}ページ）`, `✓ Trimmed ${pageCount} page${pageCount === 1 ? '' : 's'}`));
  } catch(e) {
    console.error(e);
    setStatus('trim', `${msg('エラー: ', 'Error: ')}${humanError(e)}`, true);
  } finally {
    endProcessing('trim');
    btn.disabled = false;
    btn.innerHTML = msg('✂ トリミングしてダウンロード', '✂ Trim & Download');
    setTimeout(() => prog.classList.remove('active'), 800);
  }
}

async function resetTrim() {
  if (refuseResetWhileProcessing('trim')) return;
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

// ===== REDACT / BLUR =====
let redactFile = null;
let redactBytes = null;
let redactPdfTask = null;
let redactPdfDoc = null;
let redactPageCount = 0;
let redactPageSizes = [];
let redactCurrentPage = 1;
let redactMode = 'redact';
let redactRegions = {};
let redactRegionId = 0;
let redactOutputBytes = null;
let redactOutputName = '';
let redactPreviewGeneration = 0;
let redactProcessing = false;
const REDACT_PREVIEW_SCALE = 1.25;

setupDrop('redact-drop', 'redact-file-input', loadRedactFile);
if (!CANVAS_BLUR_SUPPORTED) markBlurUnavailable();

function markBlurUnavailable() {
  const button = document.getElementById('redact-mode-blur');
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');
  button.querySelector('.redact-mode-desc').textContent = msg('このブラウザでは利用できません', 'Unavailable in this browser');
  document.getElementById('redact-blur').disabled = true;
  document.getElementById('redact-blur-settings').classList.add('unavailable');
  const notice = document.createElement('div');
  notice.className = 'security-notice';
  notice.setAttribute('role', 'note');
  notice.textContent = msg(
    'お使いのブラウザ（Safariなど）はcanvasのぼかし処理に対応していないため、ぼかしは選択できません。墨消しは通常どおり使用できます。機密情報の削除には、そもそも墨消しの使用が推奨されます。',
    'Your browser (for example Safari) does not support canvas blur, so blur cannot be selected. Redaction works normally — and redaction is the recommended choice for removing confidential information anyway.',
  );
  button.closest('.section').prepend(notice);
}

document.getElementById('redact-blur').addEventListener('input', function() {
  document.getElementById('redact-blur-val').textContent = `${this.value} px`;
  document.getElementById('redact-regions').style.setProperty('--redact-preview-blur', `${Math.max(2, Number(this.value) * 0.55)}px`);
  invalidateRedactOutput();
});
document.getElementById('redact-dpi').addEventListener('input', function() {
  document.getElementById('redact-dpi-val').textContent = `${this.value} DPI`;
  invalidateRedactOutput();
});
document.getElementById('redact-download-btn').addEventListener('click', () => {
  if (redactOutputBytes && redactOutputName) downloadBlob(redactOutputBytes, redactOutputName);
});

function totalRedactRegions() {
  return Object.values(redactRegions).reduce((total, regions) => total + regions.length, 0);
}

function invalidateRedactOutput() {
  redactOutputBytes = null;
  redactOutputName = '';
  document.getElementById('redact-result').style.display = 'none';
}

async function loadRedactFile(file) {
  if (redactProcessing) {
    throw new Error(msg('現在の処理が完了してから別のPDFを選択してください。', 'Wait for the current process to finish before selecting another PDF.'));
  }
  await resetRedact();
  redactFile = file;
  redactBytes = await file.arrayBuffer();
  const opened = await openPdfJs(redactBytes);
  redactPdfTask = opened.task;
  redactPdfDoc = opened.doc;
  redactPageCount = redactPdfDoc.numPages;
  redactPageSizes = [];

  for (let pageNumber = 1; pageNumber <= redactPageCount; pageNumber++) {
    const page = await redactPdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    redactPageSizes.push({ width: viewport.width, height: viewport.height });
    page.cleanup();
  }

  showFileInfo('redact-file-info', file.name, redactPageCount, file.size, 'resetRedact');
  document.getElementById('redact-controls').classList.remove('hidden');
  document.getElementById('redact-btn').disabled = true;
  redactCurrentPage = 1;
  setRedactMode('redact');
  setStatus('redact', '');
  await renderRedactPreview();
}

function setRedactMode(mode) {
  if (!['redact', 'blur'].includes(mode)) return;
  if (mode === 'blur' && !CANVAS_BLUR_SUPPORTED) {
    setStatus('redact', msg('このブラウザはぼかしに対応していないため、墨消しのみ使用できます。', 'This browser does not support blur, so only redaction is available.'), true);
    return;
  }
  redactMode = mode;
  for (const candidate of ['redact', 'blur']) {
    const button = document.getElementById(`redact-mode-${candidate}`);
    const active = candidate === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function currentRedactRegions() {
  return redactRegions[redactCurrentPage] || [];
}

async function renderRedactPreview() {
  if (!redactPdfDoc) return;
  const pageNumber = redactCurrentPage;
  const generation = ++redactPreviewGeneration;
  const page = await redactPdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: REDACT_PREVIEW_SCALE });
  ensureCanvasSize(viewport);
  const temporary = document.createElement('canvas');
  temporary.width = Math.ceil(viewport.width);
  temporary.height = Math.ceil(viewport.height);
  try {
    const context = temporary.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, temporary.width, temporary.height);
    await page.render({ canvasContext: context, viewport }).promise;
    if (generation !== redactPreviewGeneration || pageNumber !== redactCurrentPage) return;
    const canvas = document.getElementById('redact-canvas');
    canvas.width = temporary.width;
    canvas.height = temporary.height;
    const canvasContext = canvas.getContext('2d', { alpha: false });
    canvasContext.drawImage(temporary, 0, 0);
    updateRedactPageUi();
  } finally {
    page.cleanup();
    temporary.width = 0;
    temporary.height = 0;
  }
}

function updateRedactPageUi() {
  const size = redactPageSizes[redactCurrentPage - 1];
  document.getElementById('redact-page-label').textContent = `${redactCurrentPage} / ${redactPageCount}`;
  document.getElementById('redact-page-size').textContent = size
    ? msg(`ページ: ${size.width.toFixed(1)} × ${size.height.toFixed(1)} pt`, `Page: ${size.width.toFixed(1)} × ${size.height.toFixed(1)} pt`)
    : '—';
  renderRedactRegionOverlays();
  renderRedactRegionList();
  const total = totalRedactRegions();
  document.getElementById('redact-btn').disabled = !redactBytes || total === 0;
}

function renderRedactRegionOverlays() {
  const host = document.getElementById('redact-regions');
  host.replaceChildren();
  for (const region of currentRedactRegions()) {
    const element = document.createElement('div');
    element.className = `redact-region mode-${region.mode}`;
    element.style.left = `${region.x1 * 100}%`;
    element.style.top = `${region.y1 * 100}%`;
    element.style.width = `${(region.x2 - region.x1) * 100}%`;
    element.style.height = `${(region.y2 - region.y1) * 100}%`;
    host.appendChild(element);
  }
}

function renderRedactRegionList() {
  const list = document.getElementById('redact-region-list');
  list.replaceChildren();
  const size = redactPageSizes[redactCurrentPage - 1];
  const regions = currentRedactRegions();
  const total = totalRedactRegions();
  const redactCount = Object.values(redactRegions).flat().filter(region => region.mode === 'redact').length;
  const blurCount = total - redactCount;
  document.getElementById('redact-region-summary').textContent = msg(
    `全${total}範囲（墨消し ${redactCount}・ぼかし ${blurCount}）／このページ ${regions.length}範囲`,
    `${total} total region${total === 1 ? '' : 's'} (${redactCount} redact, ${blurCount} blur) / ${regions.length} on this page`,
  );

  regions.forEach((region, index) => {
    const item = document.createElement('div');
    item.className = 'redact-region-item';
    const kind = document.createElement('span');
    kind.className = `redact-region-kind mode-${region.mode}`;
    kind.textContent = region.mode === 'redact' ? msg('墨消し', 'REDACT') : msg('ぼかし', 'BLUR');
    const coords = document.createElement('span');
    coords.className = 'redact-region-coords';
    coords.textContent = size
      ? `#${index + 1}  L${Math.round(region.x1 * size.width)} T${Math.round(region.y1 * size.height)}  ${Math.round((region.x2 - region.x1) * size.width)}×${Math.round((region.y2 - region.y1) * size.height)} pt`
      : `#${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mi-remove redact-region-remove';
    remove.dataset.action = 'removeRedactRegion';
    remove.dataset.actionArgs = `[${region.id}]`;
    remove.setAttribute('aria-label', msg(`範囲${index + 1}を削除`, `Remove region ${index + 1}`));
    remove.textContent = '×';
    item.append(kind, coords, remove);
    list.appendChild(item);
  });
}

function addRedactRegion(region) {
  if (!redactBytes || redactProcessing) return;
  if (totalRedactRegions() >= LIMITS.maxRedactRegions) {
    throw new Error(msg(`範囲は最大${LIMITS.maxRedactRegions}個です。`, `A maximum of ${LIMITS.maxRedactRegions} regions is allowed.`));
  }
  const values = [region.x1, region.y1, region.x2, region.y2];
  if (!values.every(Number.isFinite)) throw new Error(msg('範囲の座標が不正です。', 'The region coordinates are invalid.'));
  const normalized = {
    id: ++redactRegionId,
    mode: region.mode === 'blur' ? 'blur' : 'redact',
    x1: Math.max(0, Math.min(1, Math.min(region.x1, region.x2))),
    y1: Math.max(0, Math.min(1, Math.min(region.y1, region.y2))),
    x2: Math.max(0, Math.min(1, Math.max(region.x1, region.x2))),
    y2: Math.max(0, Math.min(1, Math.max(region.y1, region.y2))),
  };
  if (normalized.x2 - normalized.x1 < 0.001 || normalized.y2 - normalized.y1 < 0.001) {
    throw new Error(msg('範囲が小さすぎます。', 'The selected region is too small.'));
  }
  if (!redactRegions[redactCurrentPage]) redactRegions[redactCurrentPage] = [];
  redactRegions[redactCurrentPage].push(normalized);
  invalidateRedactOutput();
  setStatus('redact', '');
  updateRedactPageUi();
}

function addRedactFromInputs() {
  if (!redactBytes) return;
  const size = redactPageSizes[redactCurrentPage - 1];
  const left = Number(document.getElementById('redact-left').value);
  const top = Number(document.getElementById('redact-top').value);
  const width = Number(document.getElementById('redact-width').value);
  const height = Number(document.getElementById('redact-height').value);
  if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0) {
    throw new Error(msg('0以上の位置と、1以上の幅・高さを入力してください。', 'Enter non-negative positions and positive width and height values.'));
  }
  if (left + width > size.width || top + height > size.height) {
    throw new Error(msg('入力した範囲がページの外にはみ出しています。', 'The entered region extends beyond the page.'));
  }
  addRedactRegion({
    mode: redactMode,
    x1: left / size.width,
    y1: top / size.height,
    x2: (left + width) / size.width,
    y2: (top + height) / size.height,
  });
}

function removeRedactRegion(id) {
  if (redactProcessing) return;
  const regions = currentRedactRegions();
  const next = regions.filter(region => region.id !== id);
  if (next.length === regions.length) return;
  if (next.length) redactRegions[redactCurrentPage] = next;
  else delete redactRegions[redactCurrentPage];
  invalidateRedactOutput();
  updateRedactPageUi();
}

function undoRedactRegion() {
  if (redactProcessing) return;
  const regions = currentRedactRegions();
  if (!regions.length) return;
  regions.pop();
  if (!regions.length) delete redactRegions[redactCurrentPage];
  invalidateRedactOutput();
  updateRedactPageUi();
}

function clearRedactPage() {
  if (redactProcessing) return;
  if (!currentRedactRegions().length) return;
  delete redactRegions[redactCurrentPage];
  invalidateRedactOutput();
  updateRedactPageUi();
}

function clearAllRedactRegions() {
  if (redactProcessing) return;
  redactRegions = {};
  invalidateRedactOutput();
  setStatus('redact', '');
  updateRedactPageUi();
}

async function redactNavPage(direction) {
  if (!redactPdfDoc) return;
  const next = Math.max(1, Math.min(redactPageCount, redactCurrentPage + direction));
  if (next === redactCurrentPage) return;
  redactCurrentPage = next;
  hideRedactDraft();
  await renderRedactPreview();
}

const redactPointerState = { active: false, pointerId: null, startX: 0, startY: 0 };
const redactCanvasContainer = document.getElementById('redact-canvas-container');

function redactPointerPosition(event) {
  const rect = redactCanvasContainer.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    rect,
  };
}

function showRedactDraft(x1, y1, x2, y2) {
  const draft = document.getElementById('redact-draft');
  draft.style.display = 'block';
  draft.style.left = `${Math.min(x1, x2) * 100}%`;
  draft.style.top = `${Math.min(y1, y2) * 100}%`;
  draft.style.width = `${Math.abs(x2 - x1) * 100}%`;
  draft.style.height = `${Math.abs(y2 - y1) * 100}%`;
}

function hideRedactDraft() {
  redactPointerState.active = false;
  redactPointerState.pointerId = null;
  document.getElementById('redact-draft').style.display = 'none';
}

redactCanvasContainer.addEventListener('pointerdown', event => {
  if (!redactBytes || redactProcessing || !event.isPrimary || event.button !== 0) return;
  const position = redactPointerPosition(event);
  redactPointerState.active = true;
  redactPointerState.pointerId = event.pointerId;
  redactPointerState.startX = position.x;
  redactPointerState.startY = position.y;
  redactCanvasContainer.setPointerCapture(event.pointerId);
  showRedactDraft(position.x, position.y, position.x, position.y);
  event.preventDefault();
});

redactCanvasContainer.addEventListener('pointermove', event => {
  if (!redactPointerState.active || event.pointerId !== redactPointerState.pointerId) return;
  const position = redactPointerPosition(event);
  showRedactDraft(redactPointerState.startX, redactPointerState.startY, position.x, position.y);
  event.preventDefault();
});

redactCanvasContainer.addEventListener('pointerup', event => {
  if (!redactPointerState.active || event.pointerId !== redactPointerState.pointerId) return;
  const position = redactPointerPosition(event);
  const widthPx = Math.abs(position.x - redactPointerState.startX) * position.rect.width;
  const heightPx = Math.abs(position.y - redactPointerState.startY) * position.rect.height;
  const startX = redactPointerState.startX;
  const startY = redactPointerState.startY;
  hideRedactDraft();
  if (widthPx < 4 || heightPx < 4) {
    setStatus('redact', msg('4px以上の範囲をドラッグしてください。', 'Drag a region at least 4 px wide and high.'), true);
    return;
  }
  try {
    addRedactRegion({ mode: redactMode, x1: startX, y1: startY, x2: position.x, y2: position.y });
  } catch (error) {
    setStatus('redact', humanError(error), true);
  }
  event.preventDefault();
});

redactCanvasContainer.addEventListener('pointercancel', hideRedactDraft);

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error(msg('ページ画像を作成できませんでした。', 'Could not create the page image.')));
        return;
      }
      blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

function pixelBounds(region, width, height) {
  const x1 = Math.max(0, Math.min(width, Math.floor(region.x1 * width)));
  const y1 = Math.max(0, Math.min(height, Math.floor(region.y1 * height)));
  const x2 = Math.max(x1, Math.min(width, Math.ceil(region.x2 * width)));
  const y2 = Math.max(y1, Math.min(height, Math.ceil(region.y2 * height)));
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

function applyBlurToPixels(context, originalCanvas, region, blurPixels) {
  if (!('filter' in context)) {
    throw new Error(msg('このブラウザはぼかし処理に対応していません。', 'This browser does not support canvas blur.'));
  }
  const bounds = pixelBounds(region, originalCanvas.width, originalCanvas.height);
  if (!bounds.width || !bounds.height) return;
  const padding = Math.max(4, Math.ceil(blurPixels * 3));
  const sourceX = Math.max(0, bounds.x1 - padding);
  const sourceY = Math.max(0, bounds.y1 - padding);
  const sourceX2 = Math.min(originalCanvas.width, bounds.x2 + padding);
  const sourceY2 = Math.min(originalCanvas.height, bounds.y2 + padding);
  const sourceWidth = sourceX2 - sourceX;
  const sourceHeight = sourceY2 - sourceY;
  const temporary = document.createElement('canvas');
  temporary.width = sourceWidth;
  temporary.height = sourceHeight;
  const temporaryContext = temporary.getContext('2d');
  temporaryContext.fillStyle = '#fff';
  temporaryContext.fillRect(0, 0, sourceWidth, sourceHeight);
  temporaryContext.filter = `blur(${blurPixels}px)`;
  temporaryContext.drawImage(originalCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  context.drawImage(
    temporary,
    bounds.x1 - sourceX,
    bounds.y1 - sourceY,
    bounds.width,
    bounds.height,
    bounds.x1,
    bounds.y1,
    bounds.width,
    bounds.height,
  );
  temporary.width = 0;
  temporary.height = 0;
}

function removeGeneratedPdfMetadata(documentToClean) {
  documentToClean.setTitle('');
  documentToClean.setAuthor('');
  documentToClean.setSubject('');
  documentToClean.setKeywords([]);
  documentToClean.setCreator('');
  documentToClean.setProducer('');
  documentToClean.setCreationDate(new Date(0));
  documentToClean.setModificationDate(new Date(0));
}

async function executeRedact() {
  if (!redactBytes || totalRedactRegions() === 0 || redactProcessing) return;
  const button = document.getElementById('redact-btn');
  const progress = document.getElementById('redact-progress');
  const sourceDocument = redactPdfDoc;
  const sourceFile = redactFile;
  const sourcePageCount = redactPageCount;
  const regionsForOutput = Object.fromEntries(Object.entries(redactRegions).map(([page, regions]) => [page, regions.map(region => ({ ...region }))]));
  const configurationSignature = JSON.stringify({
    regions: regionsForOutput,
    blur: document.getElementById('redact-blur').value,
    dpi: document.getElementById('redact-dpi').value,
  });
  redactProcessing = true;
  document.getElementById('redact-file-input').disabled = true;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${msg('処理中…', 'Processing…')}`;
  progress.classList.add('active');
  setProgressBar(progress, 0);
  setStatus('redact', msg('ページを安全な画像PDFへ再構築しています…', 'Rebuilding pages into a flattened image PDF…'));
  invalidateRedactOutput();

  try {
    const outputDocument = await PDFDocument.create();
    removeGeneratedPdfMetadata(outputDocument);
    const dpi = Math.max(96, Math.min(240, Number(document.getElementById('redact-dpi').value) || 150));
    const blurSetting = Math.max(4, Math.min(30, Number(document.getElementById('redact-blur').value) || 14));
    const blurPixels = blurSetting * dpi / 150;
    let runningTotal = 0;

    for (let pageNumber = 1; pageNumber <= sourcePageCount; pageNumber++) {
      const sourcePage = await sourceDocument.getPage(pageNumber);
      const baseViewport = sourcePage.getViewport({ scale: 1 });
      const viewport = sourcePage.getViewport({ scale: dpi / 72 });
      runningTotal = ensureCanvasSize(viewport, runningTotal);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await sourcePage.render({ canvasContext: context, viewport }).promise;
        const pageRegions = regionsForOutput[pageNumber] || [];
        const blurRegions = pageRegions.filter(region => region.mode === 'blur');
        const blackRegions = pageRegions.filter(region => region.mode === 'redact');

        if (blurRegions.length) {
          const originalCanvas = document.createElement('canvas');
          originalCanvas.width = canvas.width;
          originalCanvas.height = canvas.height;
          originalCanvas.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
          for (const region of blurRegions) applyBlurToPixels(context, originalCanvas, region, blurPixels);
          originalCanvas.width = 0;
          originalCanvas.height = 0;
        }

        context.filter = 'none';
        context.fillStyle = '#000';
        for (const region of blackRegions) {
          const bounds = pixelBounds(region, canvas.width, canvas.height);
          context.fillRect(bounds.x1, bounds.y1, bounds.width, bounds.height);
        }

        const pngBytes = await canvasToPng(canvas);
        const embeddedImage = await outputDocument.embedPng(pngBytes);
        const outputPage = outputDocument.addPage([baseViewport.width, baseViewport.height]);
        outputPage.drawImage(embeddedImage, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
      } finally {
        sourcePage.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
      setProgressBar(progress, pageNumber / sourcePageCount * 100);
      await sleep(10);
    }

    const generatedOutputBytes = await outputDocument.save({ useObjectStreams: true });
    const currentSignature = JSON.stringify({
      regions: redactRegions,
      blur: document.getElementById('redact-blur').value,
      dpi: document.getElementById('redact-dpi').value,
    });
    if (currentSignature !== configurationSignature || redactPdfDoc !== sourceDocument || redactFile !== sourceFile) {
      throw new Error(msg('処理中に設定が変更されました。もう一度実行してください。', 'Settings changed during processing. Run the operation again.'));
    }
    redactOutputBytes = generatedOutputBytes;
    const allRegions = Object.values(regionsForOutput).flat();
    const hasRedact = allRegions.some(region => region.mode === 'redact');
    const hasBlur = allRegions.some(region => region.mode === 'blur');
    const suffix = hasRedact && hasBlur ? '_redacted_blurred.pdf' : hasRedact ? '_redacted.pdf' : '_blurred.pdf';
    redactOutputName = `${baseName(sourceFile.name)}${suffix}`;
    document.getElementById('redact-stat-before').textContent = formatSize(sourceFile.size);
    document.getElementById('redact-stat-after').textContent = formatSize(redactOutputBytes.length);
    document.getElementById('redact-stat-regions').textContent = String(allRegions.length);
    document.getElementById('redact-result').style.display = 'block';
    setStatus('redact', hasBlur
      ? msg('✓ PDFを準備しました。ぼかしは墨消しではないため、共有前に用途を再確認してください。', '✓ PDF prepared. Blur is not redaction; confirm it is appropriate before sharing.')
      : msg('✓ 墨消し済みPDFを準備しました。ダウンロード後に全ページを確認してください。', '✓ Redacted PDF prepared. Download and inspect every page.'));
  } catch (error) {
    console.error(error);
    setStatus('redact', `${msg('エラー: ', 'Error: ')}${humanError(error)}`, true);
  } finally {
    redactProcessing = false;
    document.getElementById('redact-file-input').disabled = false;
    button.disabled = !redactBytes || totalRedactRegions() === 0;
    button.innerHTML = msg('⬛ 適用してPDFを準備', '⬛ Apply & Prepare PDF');
    setTimeout(() => progress.classList.remove('active'), 800);
  }
}

async function resetRedact() {
  if (redactProcessing) {
    setStatus('redact', msg('現在の処理が完了するまでお待ちください。', 'Wait for the current process to finish.'));
    return;
  }
  ++redactPreviewGeneration;
  hideRedactDraft();
  if (redactPdfTask) await redactPdfTask.destroy().catch(() => {});
  redactFile = null;
  redactBytes = null;
  redactPdfTask = null;
  redactPdfDoc = null;
  redactPageCount = 0;
  redactPageSizes = [];
  redactCurrentPage = 1;
  redactRegions = {};
  redactRegionId = 0;
  invalidateRedactOutput();
  document.getElementById('redact-file-info').replaceChildren();
  document.getElementById('redact-controls').classList.add('hidden');
  document.getElementById('redact-file-input').value = '';
  document.getElementById('redact-canvas').width = 0;
  document.getElementById('redact-canvas').height = 0;
  document.getElementById('redact-regions').replaceChildren();
  document.getElementById('redact-region-list').replaceChildren();
  document.getElementById('redact-region-summary').textContent = '';
  document.getElementById('redact-btn').disabled = true;
  setStatus('redact', '');
  setRedactMode('redact');
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
  setRedactMode, redactNavPage, addRedactFromInputs, removeRedactRegion,
  undoRedactRegion, clearRedactPage, clearAllRedactRegions, executeRedact, resetRedact,
});

function scopeForAction(action) {
  const lowered = action.toLowerCase();
  return ['split', 'merge', 'extract', 'rotate', 'reorder', 'compress', 'trim', 'redact'].find(scope => lowered.includes(scope));
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
    redact: !redactBytes || totalRedactRegions() === 0,
  }[scope];
  button.disabled = Boolean(disabled);
}

async function runAction(element, action, argsText) {
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
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
