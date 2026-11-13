import {
  baseName, pickImages, readEntryBytes, saveBlob, resolveSaveDir,
  isSupportedName, dirname, stemOf, isTauri, CONVERT_EXTS,
} from './platform.js';
import { encodeCanvas, imageOutputStem } from './image-util.js';
import { createIoButtons } from './io-buttons.js';
import { FORMAT_NAME, extOf, humanSize, decodeToCanvas } from './decode.js';

const $ = (id) => document.getElementById(id);
const FLOAT_EXTS = ['hdr', 'rgbe', 'exr'];
const QUALITY_FORMATS = ['JPEG', 'WEBP'];
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function animationNotice(name, bytes) {
  const ext = extOf(name);
  const animatedWebp = ext === 'webp' && bytes.length > 20 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8X' && (bytes[20] & 2);
  return ext === 'gif' || animatedWebp ? ' · 仅转换首帧' : '';
}

function outputCanvas(source, settings) {
  let { width, height } = settings;
  if (settings.aspect && (width || height)) {
    const scale = Math.min(width ? width / source.width : Infinity, height ? height / source.height : Infinity);
    width = Math.max(1, Math.round(source.width * scale));
    height = Math.max(1, Math.round(source.height * scale));
  }
  width ||= source.width;
  height ||= source.height;
  const resized = width !== source.width || height !== source.height;
  if (resized && (width > 16384 || height > 16384 || width * height > 60_000_000)) {
    throw new Error('导出尺寸超出限制（单边 16384 像素，合计 6000 万像素）');
  }
  if (!resized && settings.ext !== 'jpg') return source;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (settings.ext === 'jpg') {
    ctx.fillStyle = settings.matte;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function outputName(entry, ext, dir, entered = '') {
  const stem = imageOutputStem(entered, stemOf(entry.name), 'converted');
  const name = `${stem}.${ext}`;
  const normalize = (p) => (p || '').replace(/[/\\]+/g, '/').replace(/\/$/, '').toLowerCase();
  const sameDir = dir && entry.path && normalize(dirname(entry.path)) === normalize(dir);
  return sameDir && name.toLowerCase() === entry.name.toLowerCase() ? `${stem}_转换.${ext}` : name;
}

export function initConvert({ view }) {
  const info = $('conv-info');
  const clearBtn = $('conv-clear');
  const fmtSel = $('conv-fmt');
  const qualityIn = $('conv-quality');
  const nameIn = $('conv-name');
  const stretchChk = $('conv-stretch');
  const exportBtn = $('conv-export');
  const dirIn = $('conv-dir');
  const exportDirBtn = $('conv-export-dir');
  const batchList = $('conv-batch-list');
  const batchRetry = $('conv-batch-retry');
  const batchCancel = $('conv-batch-cancel');
  const modeSingle = $('conv-mode-single');
  const modeBatch = $('conv-mode-batch');
  const io = createIoButtons($('conv-io'), setStatus);

  let source = null;
  let loadId = 0;
  let loading = false;
  let busy = false;
  let cancelled = false;
  let batchMode = false;
  let batchFiles = [];

  function setStatus(message) {
    $('conv-status').textContent = message;
  }

  function updateControls() {
    clearBtn.disabled = !source && !loading;
    const ready = batchMode ? batchFiles.length > 0 : !!source && !loading;
    exportBtn.disabled = exportDirBtn.disabled = busy || !ready;
    batchRetry.disabled = busy || !batchFiles.some((file) => file.status === 'fail');
    batchCancel.disabled = !busy || cancelled;
    modeSingle.disabled = modeBatch.disabled = busy;
    for (const id of ['conv-batch-add', 'conv-batch-add-folder', 'conv-batch-clear']) $(id).disabled = busy;
  }

  function show() {
    view.setImage(source?.canvas, source?.canvas.width, source?.canvas.height);
    info.textContent = source
      ? `图像尺寸：${source.canvas.width}x${source.canvas.height}  |  大小：${humanSize(source.bytes.length)}  |  格式：${FORMAT_NAME[extOf(source.name)] || '未知'}${source.notice}`
      : '图像尺寸：-  |  大小：-  |  格式：-';
  }

  async function loadEntry(entry, redecoding = false) {
    const id = ++loadId;
    if (!isSupportedName(entry.name, CONVERT_EXTS)) {
      loading = false;
      updateControls();
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    loading = true;
    updateControls();
    setStatus('正在载入…');
    const stretch = stretchChk.checked;
    try {
      await nextTick();
      if (id !== loadId) return;
      const bytes = redecoding ? entry.bytes : await readEntryBytes(entry);
      if (id !== loadId) return;
      if (!bytes.length) throw new Error('文件内容为空');
      const canvas = await decodeToCanvas(entry.name, bytes, stretch);
      if (id !== loadId) return;
      // A change made while reading a new HDR/EXR should also apply to that image.
      if (FLOAT_EXTS.includes(extOf(entry.name)) && stretch !== stretchChk.checked) {
        return loadEntry({ ...entry, bytes }, true);
      }
      source = { name: entry.name, path: entry.path, bytes, canvas, notice: animationNotice(entry.name, bytes) };
      if (!redecoding) nameIn.value = '';
      show();
      io.setSource(entry.path);
      io.setExport(null);
      setStatus('已载入：' + entry.name + source.notice);
    } catch (error) {
      if (id === loadId) setStatus('载入失败：' + (error?.message ?? error));
    } finally {
      if (id === loadId) {
        loading = false;
        updateControls();
      }
    }
  }

  function clearImage() {
    ++loadId;
    source = null;
    loading = false;
    io.clear();
    nameIn.value = '';
    show();
    updateControls();
    setStatus('');
  }

  function settings() {
    const dimension = (id) => {
      const field = $(id);
      if (!field.validity.valid) throw new Error('导出宽高必须是 1 至 16384 的整数');
      return field.valueAsNumber || 0;
    };
    return {
      ext: fmtSel.value === 'JPEG' ? 'jpg' : fmtSel.value.toLowerCase(),
      quality: Number(qualityIn.value) / 100,
      width: dimension('conv-width'),
      height: dimension('conv-height'),
      aspect: $('conv-aspect').checked,
      matte: $('conv-matte').value,
      stretch: stretchChk.checked,
      original: $('conv-save-orig').checked,
    };
  }

  function applyFormat() {
    const quality = QUALITY_FORMATS.includes(fmtSel.value);
    $('conv-quality-label').hidden = $('conv-quality-row').hidden = !quality;
    $('conv-quality-num').textContent = qualityIn.value;
    $('conv-matte-label').hidden = $('conv-matte').hidden = fmtSel.value !== 'JPEG';
  }

  async function exportTo(dir) {
    if (!source || busy || loading) return;
    const entry = source;
    const entered = nameIn.value;
    busy = true;
    updateControls();
    try {
      const options = settings();
      const target = await resolveSaveDir(dir ?? (options.original ? dirname(entry.path) : null));
      if (source !== entry) return;
      if (isTauri && !target) {
        setStatus('已取消');
        return;
      }
      setStatus('正在导出…');
      await nextTick();
      const canvas = outputCanvas(entry.canvas, options);
      const bytes = await encodeCanvas(canvas, options.ext, options.quality);
      if (source !== entry) return;
      const saved = await saveBlob(outputName(entry, options.ext, target, entered), bytes, target, { unique: true });
      if (source !== entry) return;
      setStatus(`已导出：${saved}（${canvas.width}x${canvas.height}）`);
      io.setExport(target ? saved : null);
    } catch (error) {
      if (source === entry) setStatus('导出失败：' + (error?.message ?? error));
    } finally {
      busy = false;
      updateControls();
    }
  }

  function toggleBatchMode(on) {
    batchMode = on;
    $('conv-single-wrap').hidden = on;
    $('conv-batch-wrap').hidden = $('conv-batch-actions').hidden = !on;
    nameIn.hidden = $('conv-name-label').hidden = on;
    modeSingle.classList.toggle('on', !on);
    modeBatch.classList.toggle('on', on);
    exportBtn.textContent = on ? '全部导出' : '导出';
    setStatus('');
    updateControls();
  }

  function updateBatchRow(file, status, message = '') {
    file.status = status;
    file.message = message;
    file.row.dataset.status = status;
    const tags = { done: '完成', fail: '失败', run: '转换中', queue: '等待' };
    const tag = file.row.querySelector('.status-tag');
    tag.className = 'status-tag tag-' + status;
    tag.textContent = tags[status];
    const detail = file.row.querySelector('.batch-file-detail');
    detail.textContent = message;
    detail.title = message;
    detail.hidden = !message;
    const fill = file.row.querySelector('.batch-mini-bar-fill');
    fill.className = 'batch-mini-bar-fill ' + status;
    const percent = status === 'done' ? 100 : status === 'run' ? 50 : 0;
    fill.style.width = percent + '%';
    const pct = file.row.querySelector('.batch-mini-pct');
    pct.textContent = percent + '%';
    pct.className = 'batch-mini-pct ' + status;
  }

  function updateSummary() {
    const counts = { queue: 0, run: 0, done: 0, fail: 0 };
    for (const file of batchFiles) counts[file.status]++;
    $('conv-batch-count').textContent = batchFiles.length ? `· ${batchFiles.length} 个` : '';
    $('conv-batch-summary').textContent = batchFiles.length
      ? `转换中 ${counts.run}  ·  等待 ${counts.queue}  ·  完成 ${counts.done}  ·  失败 ${counts.fail}`
      : '尚未添加文件';
    updateControls();
  }

  function addBatchEntries(entries) {
    if (busy || !batchMode) return;
    const key = (entry) => entry.path?.replace(/\\/g, '/').toLowerCase() || entry.file;
    const existing = new Set(batchFiles.map(key));
    const fragment = document.createDocumentFragment();
    let added = 0;
    for (const entry of entries) {
      if (!isSupportedName(entry.name, CONVERT_EXTS) || existing.has(key(entry))) continue;
      existing.add(key(entry));
      const row = document.createElement('div');
      row.className = 'batch-file-row';
      row.innerHTML = `
        <div class="batch-file-name"><span class="status-tag"></span><span class="batch-file-basename"></span></div>
        <div class="batch-mini-bar"><div class="batch-mini-bar-fill"></div></div>
        <div class="batch-mini-pct"></div>
        <button class="batch-remove" title="移除">✕</button>
        <div class="batch-file-detail"></div>
      `;
      row.querySelector('.batch-file-basename').textContent = entry.name;
      row.querySelector('.batch-file-name').title = entry.path || entry.file?.webkitRelativePath || entry.name;
      const file = { ...entry, row };
      row.querySelector('.batch-remove').addEventListener('click', () => {
        if (busy) return;
        batchFiles = batchFiles.filter((item) => item !== file);
        row.remove();
        updateSummary();
      });
      batchFiles.push(file);
      updateBatchRow(file, 'queue');
      fragment.appendChild(row);
      added++;
    }
    batchList.appendChild(fragment);
    updateSummary();
    if (entries.length) setStatus(added ? `已加入 ${added} 个文件` : '没有可加入的新文件');
  }

  async function doBatchExport(dirArg, retry = false) {
    if (busy) return;
    const files = retry ? batchFiles.filter((file) => file.status === 'fail') : [...batchFiles];
    if (!files.length) return;
    busy = true;
    cancelled = false;
    updateControls();
    let done = 0;
    let failed = 0;
    let lastSaved = null;
    try {
      const options = settings();
      let dir = dirArg || dirIn.value.trim();
      if (isTauri && !dir && (!options.original || files.some((file) => !dirname(file.path)))) {
        dir = await resolveSaveDir(null);
        if (!dir || cancelled) {
          setStatus('已取消');
          return;
        }
      }
      if (!retry) for (const file of files) updateBatchRow(file, 'queue');
      updateSummary();
      for (const file of files) {
        if (cancelled) break;
        const target = dir || dirname(file.path) || null;
        const previousStatus = file.status;
        const previousMessage = file.message;
        updateBatchRow(file, 'run');
        updateSummary();
        setStatus(`正在转换 (${done + failed + 1}/${files.length})：${file.name}`);
        try {
          await nextTick();
          if (cancelled) break;
          const bytes = await readEntryBytes(file);
          if (cancelled) break;
          if (!bytes.length) throw new Error('文件内容为空');
          const canvas = await decodeToCanvas(file.name, bytes, options.stretch);
          if (cancelled) break;
          const resized = outputCanvas(canvas, options);
          const out = await encodeCanvas(resized, options.ext, options.quality);
          if (cancelled) break;
          const saved = await saveBlob(outputName(file, options.ext, target), out, target, { unique: true });
          if (saved === null) throw new Error('未指定导出目录');
          if (isTauri) lastSaved = saved;
          done++;
          updateBatchRow(file, 'done', `${baseName(saved)} · ${resized.width}x${resized.height}${animationNotice(file.name, bytes)}`);
        } catch (error) {
          if (cancelled) break;
          failed++;
          updateBatchRow(file, 'fail', String(error?.message ?? error));
        } finally {
          if (file.status === 'run') updateBatchRow(file, previousStatus, previousMessage);
          updateSummary();
        }
      }
      if (lastSaved) io.setExport(lastSaved);
      const waiting = files.length - done - failed;
      setStatus(`批量导出${cancelled ? '已取消' : '完成'}：成功 ${done} 个，失败 ${failed} 个${waiting ? `，未处理 ${waiting} 个` : ''}`);
    } catch (error) {
      setStatus('批量导出失败：' + (error?.message ?? error));
    } finally {
      busy = false;
      updateControls();
    }
  }

  $('conv-open').addEventListener('click', async () => {
    try {
      const entries = await pickImages(false, CONVERT_EXTS);
      if (entries.length) await loadEntry(entries[0]);
    } catch (error) {
      setStatus('打开失败：' + (error?.message ?? error));
    }
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', () => batchMode ? doBatchExport() : exportTo());
  exportDirBtn.addEventListener('click', () => {
    const dir = dirIn.value.trim();
    if (!dir) setStatus('请先填写或粘贴导出路径');
    else if (batchMode) doBatchExport(dir);
    else exportTo(dir);
  });
  $('conv-browse').addEventListener('click', async () => {
    try {
      const dir = await resolveSaveDir(null);
      if (dir) dirIn.value = dir;
    } catch (error) {
      setStatus('选择目录失败：' + (error?.message ?? error));
    }
  });
  stretchChk.addEventListener('change', () => {
    if (!loading && source && FLOAT_EXTS.includes(extOf(source.name))) loadEntry(source, true);
  });
  fmtSel.addEventListener('change', applyFormat);
  qualityIn.addEventListener('input', applyFormat);
  modeSingle.addEventListener('click', () => toggleBatchMode(false));
  modeBatch.addEventListener('click', () => toggleBatchMode(true));
  batchRetry.addEventListener('click', () => doBatchExport(undefined, true));
  batchCancel.addEventListener('click', () => {
    cancelled = true;
    updateControls();
    setStatus('正在取消…');
  });

  $('conv-batch-add').addEventListener('click', async () => {
    try {
      addBatchEntries(await pickImages(true, CONVERT_EXTS, { title: '选择图片' }));
    } catch (error) {
      setStatus('打开失败：' + (error?.message ?? error));
    }
  });
  $('conv-batch-add-folder').addEventListener('click', async () => {
    try {
      const dir = await resolveSaveDir(null);
      if (!dir) return;
      const paths = await window.__TAURI__.core.invoke('list_files', { dir });
      const entries = paths.filter((path) => isSupportedName(baseName(path), CONVERT_EXTS));
      if (!entries.length) setStatus('这个文件夹里没有可转换的图片');
      else addBatchEntries(entries.map((path) => ({ path, name: baseName(path) })));
    } catch (error) {
      setStatus('读取文件夹失败：' + (error?.message ?? error));
    }
  });
  $('conv-batch-clear').addEventListener('click', () => {
    batchFiles = [];
    batchList.replaceChildren();
    updateSummary();
    setStatus('');
  });

  for (const id of ['conv-dir-label', 'conv-dir-row', 'conv-export-dir', 'conv-batch-add-folder']) $(id).hidden = !isTauri;
  $('conv-save-orig').closest('label').hidden = !isTauri;
  applyFormat();
  toggleBatchMode(false);
  updateSummary();

  return {
    loadEntry,
    addEntries(entries) {
      if (batchMode) addBatchEntries(entries);
      else if (entries.length) loadEntry(entries[0]);
    },
  };
}
