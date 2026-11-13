// PDF 和 Word 共用分页预览与图片导出。Word 先由桌面端排版为 PDF。
import {
  isTauri,
  isSupportedName,
  pickImages,
  readEntryBytes,
  makeDir,
  saveBlob,
  openPath,
  dirname,
  stemOf,
  formatBytes,
  fileSizeOf,
  resolveSaveDir,
} from './platform.js';
import { encodeCanvas } from './image-util.js';

// pdf.js 有 350KB，还带个 1.3MB 的 worker。静态 import 会拖慢整个应用启动，
// 所以等真的要打开 PDF 了再动态加载。
let pdfjs = null;
async function ensurePdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  // worker 跟页面同源，放在 vendor 里跟着前端一起打包，离线也能用
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../vendor/pdfjs/pdf.worker.min.mjs',
    import.meta.url,
  ).href;
  return pdfjs;
}

export function initPdfPage({ word = false } = {}) {
  const prefix = word ? 'word' : 'pdf';
  const label = word ? 'Word' : 'PDF';
  const extensions = word ? ['doc', 'docx'] : ['pdf'];
  const panel = document.getElementById(`page-${prefix}`);
  const $ = (id) => document.getElementById(`${prefix}-${id}`);

  const openBtn = $('open');
  const nameEl = $('file-name');
  const prevWrap = $('prev-wrap');
  const canvas = $('canvas');
  const emptyEl = $('empty');
  const prevBtn = $('prev');
  const nextBtn = $('next');
  const jumpBtn = $('jump');
  const pageInput = $('page-input');
  const pageTotal = $('page-total');
  const statusEl = $('status');
  const zoomSel = $('zoom');

  const fmtSel = $('fmt');
  const qualityLabel = $('quality-label');
  const qualityRow = $('quality-row');
  const qualityIn = $('quality');
  const qualityNum = $('quality-num');
  const dpiSel = $('dpi');
  const dirIn = $('dir');
  const browseBtn = $('browse');
  const exportBtn = $('export');
  const exportStatus = $('export-status');
  const progressFill = $('progress-fill');
  const progressText = $('progress-text');
  const openDirBtn = $('open-dir');
  const openSrcBtn = $('open-src');
  const rangeBtns = [...$('range').querySelectorAll('.btn')];

  let doc = null;
  let entry = null;
  let pageNum = 1;
  let pageCount = 0;
  let exporting = false;
  let loading = false;
  let cancelExport = false;
  let customDir = null;
  let renderToken = 0;
  let pdfBytes = null;
  let lastExportDir = null;

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isErr);
  }
  function setExportStatus(msg, isErr = false) {
    exportStatus.textContent = msg || '';
    exportStatus.classList.toggle('err', !!isErr);
  }

  // 默认在源文件同级使用同名文件夹。
  function defaultDir() {
    if (!entry) return null;
    if (!isTauri || !entry.path) return null;
    const parent = dirname(entry.path);
    const stem = stemOf(entry.name);
    if (!parent || !stem) return null;
    const sep = parent.includes('\\') ? '\\' : '/';
    return parent + sep + stem;
  }

  function outDir() {
    return customDir || defaultDir();
  }

  function syncDir() {
    const d = outDir();
    dirIn.value = d || '';
    dirIn.title = d || '';
    openDirBtn.disabled = !isTauri || !d || d !== lastExportDir;
  }

  // 品质只在 JPEG 下有意义：PNG 是无损的
  function applyQuality() {
    const on = fmtSel.value === 'jpg';
    qualityLabel.hidden = !on;
    qualityRow.hidden = !on;
    qualityNum.textContent = qualityIn.value;
    if (word) {
      const pdf = fmtSel.value === 'pdf';
      $('dpi-label').hidden = dpiSel.hidden = pdf;
    }
    syncExportLabel();
  }

  // 预览缩放：fit = 按窗口自适应；1 = PDF 原始点尺寸；2 = 两倍
  function previewScale(page) {
    const base = page.getViewport({ scale: 1 });
    const mode = zoomSel.value;
    if (mode !== 'fit') return Number(mode);
    const w = Math.max(80, prevWrap.clientWidth - 24);
    const h = Math.max(80, prevWrap.clientHeight - 24);
    if (!base.width || !base.height) return 1;
    return Math.max(0.1, Math.min(w / base.width, h / base.height));
  }

  // 渲染到离屏 canvas：翻页快的时候旧的那次渲染后完成也不会把画面画花
  async function renderToCanvas(page, scale) {
    const viewport = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(viewport.width));
    off.height = Math.max(1, Math.floor(viewport.height));
    if (off.width > 16384 || off.height > 16384 || off.width * off.height > 64_000_000) {
      throw new Error('页面分辨率过大，请降低图片 DPI');
    }
    const ctx = off.getContext('2d');
    if (!ctx) throw new Error('无法创建页面画布，请降低图片 DPI');
    // PDF 页面可能有透明区域，JPEG 导出时透明会变黑，所以先铺白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return off;
  }

  async function renderPage(n) {
    if (!doc || panel.classList.contains('hidden')) return;
    const mine = ++renderToken;
    try {
      const page = await doc.getPage(n);
      if (mine !== renderToken) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const off = await renderToCanvas(page, previewScale(page) * dpr);
      if (mine !== renderToken) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.style.width = Math.round(off.width / dpr) + 'px';
      canvas.style.height = Math.round(off.height / dpr) + 'px';
      canvas.getContext('2d').drawImage(off, 0, 0);
      canvas.hidden = false;
      emptyEl.hidden = true;
    } catch (error) {
      if (mine !== renderToken) return;
      canvas.hidden = true;
      emptyEl.hidden = false;
      setStatus('预览失败：' + (error?.message ?? error), true);
    }
  }

  function syncPager() {
    pageTotal.textContent = String(pageCount || 0);
    pageInput.max = String(Math.max(1, pageCount || 1));
    if (pageNum < 1) pageNum = 1;
    if (pageCount && pageNum > pageCount) pageNum = pageCount;
    pageInput.value = String(pageNum);
    const busy = loading || exporting;
    prevBtn.disabled = !pageCount || pageNum <= 1 || busy;
    nextBtn.disabled = !pageCount || pageNum >= pageCount || busy;
    jumpBtn.disabled = pageInput.disabled = !pageCount || busy;
    exportBtn.disabled = loading || !doc || (exporting && cancelExport);
    openBtn.disabled = busy || (word && !isTauri);
    browseBtn.disabled = busy;
  }

  async function goto(n) {
    if (!doc || loading || exporting) return;
    const target = Math.min(Math.max(1, Math.trunc(n)), pageCount || 1);
    pageNum = target;
    syncPager();
    setStatus('');
    await renderPage(target);
  }

  async function convertWord(file, page = null) {
    const result = await window.__TAURI__.core.invoke('convert_word_to_pdf', { path: file.path, page });
    return result instanceof ArrayBuffer ? new Uint8Array(result) : Uint8Array.from(result);
  }

  async function loadEntry(e) {
    if (!e || loading || exporting) return;
    if (!isSupportedName(e.name, extensions)) {
      setStatus(`这里支持 ${extensions.join(' / ').toUpperCase()} 文件：${e.name}`, true);
      return;
    }
    if (word && (!isTauri || !e.path)) {
      setStatus('请在 Windows 桌面版打开 Word 文档', true);
      return;
    }
    loading = true;
    syncPager();
    setStatus(word ? '正在排版 Word 文档…' : '正在读取 PDF…');
    let task = null;
    try {
      const [lib, bytes, size] = await Promise.all([
        ensurePdfjs(), word ? convertWord(e) : readEntryBytes(e), fileSizeOf(e),
      ]);
      if (!bytes.length) throw new Error('文件内容为空');
      task = lib.getDocument({ data: word ? bytes.slice() : bytes });
      const d = await task.promise;
      const old = doc;
      ++renderToken;
      doc = d;
      entry = e;
      pdfBytes = word ? bytes : null;
      pageCount = d.numPages;
      pageNum = 1;
      customDir = null;
      lastExportDir = null;
      canvas.hidden = true;
      emptyEl.hidden = false;
      if (old) old.destroy().catch(() => {});
      nameEl.textContent = `${e.name} · ${pageCount} 页${size ? ' · ' + formatBytes(size) : ''}`;
      nameEl.title = e.path || e.name;
      openSrcBtn.disabled = !isTauri || !e.path;
      syncDir();
      syncExportLabel();
      setStatus('');
      setExportStatus('');
      setProgress(0);
      await renderPage(1);
    } catch (err) {
      if (task) task.destroy().catch(() => {});
      setStatus(`${label} 打不开：` + (err?.message ?? err), true);
    } finally {
      loading = false;
      syncPager();
    }
  }

  openBtn.addEventListener('click', async () => {
    try {
      const list = await pickImages(false, extensions, { title: `选择 ${label} 文件`, label: `${label} 文件` });
      if (list.length) await loadEntry(list[0]);
    } catch (error) {
      setStatus('打开失败：' + (error?.message ?? error), true);
    }
  });

  prevBtn.addEventListener('click', () => goto(pageNum - 1));
  nextBtn.addEventListener('click', () => goto(pageNum + 1));
  jumpBtn.addEventListener('click', () => goto(Number(pageInput.value) || 1));
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goto(Number(pageInput.value) || 1);
  });
  zoomSel.addEventListener('change', () => {
    if (doc) renderPage(pageNum);
  });

  // 窗口大小变了，「适应窗口」那一档要重算一次
  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!doc || zoomSel.value !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage(pageNum), 150);
  }).observe(prevWrap);
  new MutationObserver(() => {
    if (!panel.classList.contains('hidden') && canvas.hidden) renderPage(pageNum);
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });

  fmtSel.addEventListener('change', applyQuality);
  qualityIn.addEventListener('input', () => {
    qualityNum.textContent = qualityIn.value;
  });

  browseBtn.addEventListener('click', async () => {
    const selectedEntry = entry;
    try {
      const d = await resolveSaveDir(null);
      if (!d || selectedEntry !== entry || exporting) return;
      customDir = d;
      syncDir();
    } catch (error) {
      setExportStatus('选择目录失败：' + (error?.message ?? error), true);
    }
  });

  // 导出目录 / 源文件目录：浏览器环境里没有资源管理器可开，整行藏掉
  openDirBtn.addEventListener('click', async () => {
    const d = outDir();
    if (!d) return;
    const err = await openPath(d);
    if (err) setExportStatus(err, true);
  });
  openSrcBtn.addEventListener('click', async () => {
    if (!entry?.path) return;
    const err = await openPath(dirname(entry.path));
    if (err) setExportStatus(err, true);
  });
  openDirBtn.hidden = !isTauri;
  openSrcBtn.hidden = !isTauri;
  openDirBtn.closest('.pdf-dir-row').hidden = !isTauri;
  if (!isTauri) {
    const dirRow = dirIn.closest('.size-row');
    dirRow.hidden = dirRow.previousElementSibling.hidden = true;
    if (word) setStatus('Word 转换需要 Windows 桌面版');
  }

  // ===== 导出 =====

  function selectedPages() {
    const mode = rangeBtns.find((b) => b.classList.contains('on'))?.dataset.range || 'all';
    if (mode === 'current') return [pageNum];
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  function syncExportLabel() {
    if (exporting) return;
    const mode = rangeBtns.find((b) => b.classList.contains('on'))?.dataset.range || 'all';
    const target = fmtSel.value === 'pdf' ? ' PDF' : '';
    exportBtn.textContent = mode === 'current' ? `导出当前页${target}` : `导出全部 ${pageCount} 页${target}`;
  }

  for (const b of rangeBtns) {
    b.addEventListener('click', () => {
      for (const x of rangeBtns) x.classList.toggle('on', x === b);
      syncExportLabel();
    });
  }

  function setProgress(percent) {
    const p = Math.max(0, Math.min(100, percent));
    progressFill.style.width = p + '%';
    progressText.textContent = Math.round(p) + '%';
  }

  exportBtn.addEventListener('click', async () => {
    if (exporting) {
      cancelExport = true;
      exportBtn.textContent = '正在停止…';
      syncPager();
      return;
    }
    if (!doc || loading) return;
    const pages = selectedPages();
    if (!pages.length) return;
    const dir = outDir();
    if (isTauri && !dir) {
      setExportStatus('还没有导出目录，先选一个', true);
      return;
    }
    exporting = true;
    cancelExport = false;
    exportBtn.textContent = '停止导出';
    syncPager();
    setExportStatus(`正在导出 ${pages.length} 页…`);
    setProgress(0);

    const fmt = fmtSel.value;
    const quality = Math.min(1, Math.max(0.1, Number(qualityIn.value) / 100));
    // DPI 选项存的是相对 72 DPI 的倍率：300 DPI ≈ 4.17 倍
    const scale = Number(dpiSel.value);
    const stem = stemOf(entry?.name || 'page');
    const width = Math.max(3, String(pageCount).length);
    const currentDocument = doc;
    const source = entry;
    const currentOnly = rangeBtns.some((button) => button.dataset.range === 'current' && button.classList.contains('on'));
    const pageName = (n) => `${stem}_${String(n).padStart(width, '0')}`;

    try {
      if (dir) await makeDir(dir);
      let done = 0;
      if (fmt === 'pdf') {
        if (!cancelExport) {
          const bytes = currentOnly && pageCount > 1 ? await convertWord(source, pages[0]) : pdfBytes;
          if (!cancelExport) {
            const name = `${currentOnly ? pageName(pages[0]) : stem}.pdf`;
            const path = await saveBlob(name, bytes, dir, { unique: true });
            lastExportDir = dir;
            done = pages.length;
            setProgress(100);
            setExportStatus(`导出完成：${path}`);
          }
        }
      } else {
        for (const n of pages) {
          if (cancelExport) break;
          const page = await currentDocument.getPage(n);
          const off = await renderToCanvas(page, scale);
          const bytes = await encodeCanvas(off, fmt, quality);
          off.width = off.height = 0;
          if (cancelExport) break;
          await saveBlob(`${pageName(n)}.${fmt}`, bytes, dir, { unique: true });
          lastExportDir = dir;
          done += 1;
          setProgress((done / pages.length) * 100);
          setExportStatus(`正在导出 ${done}/${pages.length} 页…`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (cancelExport && done < pages.length) {
        setExportStatus(`已停止（已导出 ${done} 页）`);
      } else if (fmt !== 'pdf') {
        setExportStatus(`导出完成：${done} 页 → ${dir || '浏览器下载'}`);
      }
    } catch (err) {
      setExportStatus('导出失败：' + (err?.message || err), true);
    } finally {
      exporting = false;
      syncDir();
      syncExportLabel();
      syncPager();
    }
  });

  applyQuality();
  syncDir();
  syncPager();
  syncExportLabel();

  return {
    loadEntry,
    // 拖进来的是一批文件，这一页一次只吃一个
    addEntries(entries) {
      if (entries?.length) loadEntry(entries.find((item) => isSupportedName(item.name, extensions)) || entries[0]);
    },
  };
}
