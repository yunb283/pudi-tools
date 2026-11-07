import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
  isSupportedName,
  dirname,
  stemOf,
  isTauri,
  CONVERT_EXTS,
} from './platform.js';
import { encodeCanvas } from './image-util.js';
import { createIoButtons } from './io-buttons.js';
import { FORMAT_NAME, extOf, humanSize, decodeToCanvas } from './decode.js';

const $ = (id) => document.getElementById(id);

const FLOAT_EXTS = ['hdr', 'rgbe', 'exr'];
// 有损格式才有品质可调；PNG / TGA 是无损的，滑条对它们没意义
const QUALITY_FORMATS = ['JPEG', 'WEBP'];

export function initConvert({ view }) {
  const info = $('conv-info');
  const openBtn = $('conv-open');
  const clearBtn = $('conv-clear');
  const fmtSel = $('conv-fmt');
  const qualityIn = $('conv-quality');
  const qualityNum = $('conv-quality-num');
  const qualityLabel = $('conv-quality-label');
  const qualityRow = $('conv-quality-row');
  const nameIn = $('conv-name');
  const nameLabel = $('conv-name-label');
  const saveOrigChk = $('conv-save-orig');
  const stretchChk = $('conv-stretch');
  const exportBtn = $('conv-export');
  const dirIn = $('conv-dir');
  const browseBtn = $('conv-browse');
  const exportDirBtn = $('conv-export-dir');
  const status = $('conv-status');
  const io = createIoButtons($('conv-io'), setStatus);

  // 批量模式那几件
  const singleWrap = $('conv-single-wrap');
  const batchWrap = $('conv-batch-wrap');
  const batchListEl = $('conv-batch-list');
  const batchCountEl = $('conv-batch-count');
  const batchSummaryEl = $('conv-batch-summary');
  const batchAddBtn = $('conv-batch-add');
  const batchAddFolderBtn = $('conv-batch-add-folder');
  const batchClearBtn = $('conv-batch-clear');
  const modeSingleBtn = $('conv-mode-single');
  const modeBatchBtn = $('conv-mode-batch');

  let canvas = null;
  let sourcePath = null;
  let sourceName = '';
  let sourceBytes = 0;
  let lastBytes = null;

  let batchMode = false;
  let batchFiles = []; // [{ path, name, file, status, percent, outPath }]
  let batchBusy = false;

  function setStatus(msg) {
    status.textContent = msg;
  }

  function updateInfo() {
    if (!canvas) {
      info.textContent = '图像尺寸：-  |  大小：-  |  格式：-';
      return;
    }
    info.textContent =
      `图像尺寸：${canvas.width}x${canvas.height}  |  ` +
      `大小：${humanSize(sourceBytes)}  |  ` +
      `格式：${FORMAT_NAME[extOf(sourceName)] || '未知'}`;
  }

  function setEnabled(on) {
    clearBtn.disabled = !on;
    exportBtn.disabled = batchMode ? !batchFiles.length : !on;
    browseBtn.disabled = !on && !batchMode;
    exportDirBtn.disabled = batchMode ? !batchFiles.length : !on;
  }

  function show(c) {
    canvas = c;
    view.setImage(canvas, canvas.width, canvas.height);
    setEnabled(true);
    updateInfo();
  }

  async function loadEntry(entry) {
    if (!isSupportedName(entry.name, CONVERT_EXTS)) {
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    setStatus('正在载入…');
    // 让状态先上屏，再执行解码等耗时同步操作
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await readEntryBytes(entry);
      if (!bytes.length) throw new Error('文件内容为空');
      lastBytes = bytes;
      sourcePath = entry.path;
      sourceName = entry.name;
      sourceBytes = bytes.length;
      nameIn.value = '';
      show(await decodeToCanvas(entry.name, bytes, stretchChk.checked));
      io.setSource(entry.path);
      io.setExport(null);
      setStatus('已载入：' + entry.name);
    } catch (ex) {
      lastBytes = null;
      setStatus('载入失败：' + (ex?.message ?? ex));
    }
  }

  async function reloadDecoded() {
    if (!lastBytes || !FLOAT_EXTS.includes(extOf(sourceName))) return;
    try {
      show(await decodeToCanvas(sourceName, lastBytes, stretchChk.checked));
      setStatus(stretchChk.checked ? '已按最大值重新量化' : '已按线性裁剪重新量化');
    } catch (ex) {
      setStatus('重新载入失败：' + (ex?.message ?? ex));
    }
  }

  function clearImage() {
    if (!canvas) return;
    canvas = null;
    lastBytes = null;
    sourcePath = null;
    sourceName = '';
    sourceBytes = 0;
    io.clear();
    view.setImage(null);
    setEnabled(false);
    updateInfo();
    setStatus('');
  }

  // 输出格式 → 扩展名
  function targetExt() {
    return fmtSel.value === 'JPEG' ? 'jpg' : fmtSel.value.toLowerCase();
  }

  // 品质：滑条 10~100 映射到 0.1~1.0，默认拉满
  function qualityValue() {
    return Math.min(1, Math.max(0.1, Number(qualityIn.value) / 100));
  }

  function applyQuality() {
    const on = QUALITY_FORMATS.includes(fmtSel.value);
    qualityLabel.hidden = !on;
    qualityRow.hidden = !on;
    qualityNum.textContent = qualityIn.value;
  }

  // 同目录同后缀会覆盖原图，这时自动换个名
  function outName(ext, dir) {
    const stem = nameIn.value.trim() || (sourceName ? stemOf(sourceName) : 'converted');
    const norm = (p) => (p || '').replace(/\//g, '\\').toLowerCase();
    const sameDir = !!dir && !!sourcePath && norm(dirname(sourcePath)) === norm(dir);
    const name = `${stem}.${ext}`;
    if (sameDir && name.toLowerCase() === sourceName.toLowerCase()) return `${stem}_转换.${ext}`;
    return name;
  }

  // 批量用：沿用各自原文件名，不吃「文件名」输入框
  function batchOutName(f, ext, dir) {
    const stem = stemOf(f.name) || 'converted';
    const norm = (p) => (p || '').replace(/\//g, '\\').toLowerCase();
    const sameDir = !!dir && !!f.path && norm(dirname(f.path)) === norm(dir);
    const name = `${stem}.${ext}`;
    if (sameDir && name.toLowerCase() === f.name.toLowerCase()) return `${stem}_转换.${ext}`;
    return name;
  }

  async function exportTo(dir) {
    if (!canvas) return;
    const ext = targetExt();
    let target = dir;
    if (target === undefined) {
      target = saveOrigChk.checked && sourcePath ? dirname(sourcePath) : null;
      target = await resolveSaveDir(target);
      if (isTauri && !target) return;
    }
    setStatus('正在导出…');
    await new Promise((r) => setTimeout(r, 0));
    try {
      const bytes = await encodeCanvas(canvas, ext, qualityValue());
      const saved = await saveBlob(outName(ext, target), bytes, target);
      if (saved === null) {
        setStatus('已取消');
        return;
      }
      setStatus('已导出：' + saved);
      io.setExport(target ? saved : null);
    } catch (ex) {
      setStatus('导出失败：' + (ex?.message ?? ex));
    }
  }

  // ===== 批量转换 =====

  function toggleBatchMode(mode) {
    batchMode = !!mode;
    if (batchMode) {
      singleWrap.hidden = true;
      batchWrap.hidden = false;
      modeSingleBtn.classList.remove('on');
      modeBatchBtn.classList.add('on');
      // 批量里各自沿用原文件名，这个输入框用不上
      nameLabel.hidden = true;
      nameIn.hidden = true;
      exportBtn.textContent = '全部导出';
    } else {
      singleWrap.hidden = false;
      batchWrap.hidden = true;
      modeBatchBtn.classList.remove('on');
      modeSingleBtn.classList.add('on');
      nameLabel.hidden = false;
      nameIn.hidden = false;
      exportBtn.textContent = '导出';
    }
    setEnabled(!!canvas);
    exportBtn.disabled = batchMode ? !batchFiles.length : !canvas;
  }

  function renderBatchList() {
    batchListEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    batchFiles.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'batch-file-row';
      row.dataset.idx = i;

      const tagClass =
        f.status === 'done' ? 'tag-done' : f.status === 'fail' ? 'tag-fail' : f.status === 'run' ? 'tag-run' : 'tag-queue';
      const tagText =
        f.status === 'done' ? '✓ 完成' : f.status === 'fail' ? '✗ 失败' : f.status === 'run' ? '转换中' : '等待';

      row.innerHTML = `
        <div class="batch-file-name"><span class="status-tag ${tagClass}">${tagText}</span>${f.name}</div>
        <div class="batch-mini-bar"><div class="batch-mini-bar-fill ${tagClass.replace('tag-', '')}" style="width:${Math.round((f.percent || 0) * 100)}%;"></div></div>
        <div class="batch-mini-pct ${tagClass === 'tag-done' ? 'done' : tagClass === 'tag-fail' ? 'fail' : ''}">${Math.round((f.percent || 0) * 100)}%</div>
        <button class="batch-remove" title="移除">✕</button>
      `;
      row.querySelector('.batch-remove').addEventListener('click', () => {
        if (batchBusy) return;
        batchFiles.splice(i, 1);
        renderBatchList();
        updateSummary();
        exportBtn.disabled = !batchFiles.length;
      });
      frag.appendChild(row);
    });
    batchListEl.appendChild(frag);
    batchCountEl.textContent = batchFiles.length ? `· ${batchFiles.length} 个` : '';
  }

  function updateSummary() {
    const q = batchFiles.filter((f) => f.status === 'queue').length;
    const r = batchFiles.filter((f) => f.status === 'run').length;
    const d = batchFiles.filter((f) => f.status === 'done').length;
    const f = batchFiles.filter((f) => f.status === 'fail').length;
    batchSummaryEl.innerHTML = batchFiles.length
      ? `<span><span class="dot" style="background:#39c7ed;"></span>转换中 ${r}</span>
         <span><span class="dot" style="background:#9a9ca5;"></span>等待 ${q}</span>
         <span><span class="dot" style="background:#2ecc71;"></span>完成 ${d}</span>
         <span><span class="dot" style="background:#e74c3c;"></span>失败 ${f}</span>`
      : '尚未添加文件';
  }

  function setBatchStatus(i, status, percent = null) {
    if (i < 0 || i >= batchFiles.length) return;
    batchFiles[i].status = status;
    if (percent !== null) batchFiles[i].percent = percent;
    const row = batchListEl.querySelectorAll('.batch-file-row')[i];
    if (!row) return;
    const tagClass =
      status === 'done' ? 'tag-done' : status === 'fail' ? 'tag-fail' : status === 'run' ? 'tag-run' : 'tag-queue';
    const tagText = status === 'done' ? '✓ 完成' : status === 'fail' ? '✗ 失败' : status === 'run' ? '转换中' : '等待';
    row.querySelector('.status-tag').className = `status-tag ${tagClass}`;
    row.querySelector('.status-tag').textContent = tagText;
    const fill = row.querySelector('.batch-mini-bar-fill');
    fill.className = `batch-mini-bar-fill ${tagClass.replace('tag-', '')}`;
    if (percent !== null) fill.style.width = `${Math.round(percent * 100)}%`;
    const pct = row.querySelector('.batch-mini-pct');
    pct.textContent = `${Math.round((percent !== null ? percent : (batchFiles[i].percent || 0)) * 100)}%`;
    pct.className = `batch-mini-pct ${tagClass === 'tag-done' ? 'done' : tagClass === 'tag-fail' ? 'fail' : ''}`;
    updateSummary();
  }

  // 拖进来 / 选进来的一批文件
  function addBatchEntries(entries) {
    if (batchBusy) return;
    const existing = new Set(batchFiles.map((f) => f.path || f.name));
    let added = 0;
    for (const e of entries) {
      if (!isSupportedName(e.name, CONVERT_EXTS)) continue;
      const key = e.path || e.name;
      if (existing.has(key)) continue;
      existing.add(key);
      batchFiles.push({ path: e.path, name: e.name, file: e.file || null, status: 'queue', percent: 0 });
      added++;
    }
    if (!added) {
      if (entries.length) setStatus('没有可加入的新文件（格式不支持或已经在列表里）');
      return;
    }
    renderBatchList();
    updateSummary();
    exportBtn.disabled = !batchFiles.length;
    setStatus(`已加入 ${added} 个文件到待转换列表`);
  }

  async function doBatchExport(dirArg) {
    if (!batchFiles.length || batchBusy) return;
    // 输出目录：填了就用它；没填且勾了「原图目录」就各存各的旁边；
    // 都没说就弹一次目录选择框，整批存到一个地方
    let dir = dirArg || dirIn.value.trim();
    if (!dir && !saveOrigChk.checked) {
      dir = await resolveSaveDir(null);
      if (!dir) {
        setStatus('已取消');
        return;
      }
    }
    batchBusy = true;
    exportBtn.disabled = true;
    exportDirBtn.disabled = true;
    const ext = targetExt();
    const q = qualityValue();
    let done = 0;
    let failed = 0;
    let lastDir = null;
    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      if (f.status === 'done') continue;
      const target = dir || (f.path ? dirname(f.path) : null);
      setBatchStatus(i, 'run', 0);
      setStatus(`正在转换 (${i + 1}/${batchFiles.length})：${f.name}`);
      await new Promise((r) => setTimeout(r, 0));
      try {
        const bytes = await readEntryBytes({ path: f.path, file: f.file });
        if (!bytes.length) throw new Error('文件内容为空');
        const c = await decodeToCanvas(f.name, bytes, stretchChk.checked);
        const out = await encodeCanvas(c, ext, q);
        const saved = await saveBlob(batchOutName(f, ext, target), out, target);
        if (saved === null) {
          setBatchStatus(i, 'fail');
          failed++;
          continue;
        }
        f.outPath = saved;
        lastDir = target;
        setBatchStatus(i, 'done', 1);
        done++;
      } catch (ex) {
        setBatchStatus(i, 'fail');
        failed++;
      }
    }
    batchBusy = false;
    exportBtn.disabled = !batchFiles.length;
    exportDirBtn.disabled = !batchFiles.length;
    if (lastDir) io.setExport(lastDir);
    setStatus(`批量导出完成：成功 ${done} 个，失败 ${failed} 个`);
  }

  // 拖入：批量模式整批收下，单个模式只取第一个
  function addEntries(entries) {
    if (batchMode) {
      addBatchEntries(entries);
      return;
    }
    if (entries.length) loadEntry(entries[0]);
  }

  // ===== 按钮绑定 =====
  openBtn.addEventListener('click', async () => {
    const entries = await pickImages(false, CONVERT_EXTS);
    if (entries.length) await loadEntry(entries[0]);
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', () => {
    if (batchMode) doBatchExport();
    else exportTo(undefined);
  });
  exportDirBtn.addEventListener('click', () => {
    const dir = dirIn.value.trim();
    if (!dir) {
      setStatus('请先填写或粘贴导出路径');
      return;
    }
    if (batchMode) doBatchExport(dir);
    else exportTo(dir);
  });
  browseBtn.addEventListener('click', async () => {
    const dir = await resolveSaveDir(null);
    if (dir) dirIn.value = dir;
  });
  stretchChk.addEventListener('change', reloadDecoded);
  fmtSel.addEventListener('change', applyQuality);
  qualityIn.addEventListener('input', () => {
    qualityNum.textContent = qualityIn.value;
  });

  modeSingleBtn.addEventListener('click', () => toggleBatchMode(false));
  modeBatchBtn.addEventListener('click', () => toggleBatchMode(true));

  batchAddBtn.addEventListener('click', async () => {
    if (batchBusy) return;
    const entries = await pickImages(true, CONVERT_EXTS, { title: '选择图片' });
    if (entries?.length) addBatchEntries(entries);
  });

  batchAddFolderBtn.addEventListener('click', async () => {
    if (batchBusy) return;
    const dir = await window.__TAURI__.core.invoke('pick_dir');
    if (!dir) return;
    try {
      const files = await window.__TAURI__.core.invoke('list_files', { dir });
      const existing = new Set(batchFiles.map((f) => f.path || f.name));
      const added = [];
      for (const p of files) {
        const sepIdx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        const name = sepIdx >= 0 ? p.substring(sepIdx + 1) : p;
        if (existing.has(p) || !isSupportedName(name, CONVERT_EXTS)) continue;
        existing.add(p);
        added.push({ path: p, name, file: null, status: 'queue', percent: 0 });
      }
      if (!added.length) {
        setStatus('这个文件夹里没有可转换的图片');
        return;
      }
      batchFiles.push(...added);
      renderBatchList();
      updateSummary();
      exportBtn.disabled = !batchFiles.length;
      setStatus(`已加入 ${added.length} 个文件到待转换列表`);
    } catch (ex) {
      setStatus('读取文件夹失败：' + (ex?.message ?? ex));
    }
  });

  batchClearBtn.addEventListener('click', () => {
    if (batchBusy) return;
    batchFiles = [];
    renderBatchList();
    updateSummary();
    exportBtn.disabled = true;
    exportDirBtn.disabled = true;
    setStatus('');
  });

  applyQuality();
  renderBatchList();
  updateSummary();

  return { loadEntry, addEntries };
}
