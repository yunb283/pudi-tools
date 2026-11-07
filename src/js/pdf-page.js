// PDF 转图片：左边预览 + 翻页，右边导出设置。
// 渲染用 pdf.js（src/vendor/pdfjs，离线可用），文件读写走 Tauri 的 read_file / write_file。
import {
  isTauri,
  isPdfName,
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

export function initPdfPage() {
  const $ = (id) => document.getElementById(id);

  const openBtn = $('pdf-open');
  const nameEl = $('pdf-file-name');
  const prevWrap = $('pdf-prev-wrap');
  const canvas = $('pdf-canvas');
  const emptyEl = $('pdf-empty');
  const prevBtn = $('pdf-prev');
  const nextBtn = $('pdf-next');
  const jumpBtn = $('pdf-jump');
  const pageInput = $('pdf-page-input');
  const pageTotal = $('pdf-page-total');
  const statusEl = $('pdf-status');
  const zoomSel = $('pdf-zoom');

  const fmtSel = $('pdf-fmt');
  const qualityLabel = $('pdf-quality-label');
  const qualityRow = $('pdf-quality-row');
  const qualityIn = $('pdf-quality');
  const qualityNum = $('pdf-quality-num');
  const dpiSel = $('pdf-dpi');
  const dirIn = $('pdf-dir');
  const browseBtn = $('pdf-browse');
  const exportBtn = $('pdf-export');
  const exportStatus = $('pdf-export-status');
  const progressFill = $('pdf-progress-fill');
  const progressText = $('pdf-progress-text');
  const openDirBtn = $('pdf-open-dir');
  const openSrcBtn = $('pdf-open-src');
  const rangeBtns = [...document.querySelectorAll('#pdf-range .btn')];

  let doc = null;
  let entry = null;
  let pageNum = 1;
  let pageCount = 0;
  let exporting = false;
  let cancelExport = false;
  let customDir = null; // 用户手动改过的导出目录；null = 用默认（PDF 同级同名文件夹）
  let renderToken = 0;

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isErr);
  }
  function setExportStatus(msg, isErr = false) {
    exportStatus.textContent = msg || '';
    exportStatus.classList.toggle('err', !!isErr);
  }

  // PDF 同级、同名的文件夹：xxx.pdf → xxx\，导出的一张张图就放这里
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
    dirIn.value = d || (isTauri ? '（浏览器预览环境没有磁盘目录）' : '默认：浏览器下载');
    dirIn.title = d || '';
  }

  // 品质只在 JPEG 下有意义：PNG 是无损的
  function applyQuality() {
    const on = fmtSel.value === 'jpg';
    qualityLabel.hidden = !on;
    qualityRow.hidden = !on;
    qualityNum.textContent = qualityIn.value;
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
    const ctx = off.getContext('2d');
    // PDF 页面可能有透明区域，JPEG 导出时透明会变黑，所以先铺白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return off;
  }

  async function renderPage(n) {
    if (!doc) return;
    const mine = ++renderToken;
    const page = await doc.getPage(n);
    if (mine !== renderToken) return;
    const scale = previewScale(page);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const off = await renderToCanvas(page, scale * dpr);
    if (mine !== renderToken) return;
    const ctx = canvas.getContext('2d');
    canvas.width = off.width;
    canvas.height = off.height;
    // 显示尺寸按 CSS 像素算，高分屏上才是清楚的、又不撑大页面
    canvas.style.width = Math.round(off.width / dpr) + 'px';
    canvas.style.height = Math.round(off.height / dpr) + 'px';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0);
    canvas.hidden = false;
    emptyEl.hidden = true;
  }

  function syncPager() {
    pageTotal.textContent = String(pageCount || 0);
    pageInput.max = String(Math.max(1, pageCount || 1));
    if (pageNum < 1) pageNum = 1;
    if (pageCount && pageNum > pageCount) pageNum = pageCount;
    pageInput.value = String(pageNum);
    prevBtn.disabled = !pageCount || pageNum <= 1 || exporting;
    nextBtn.disabled = !pageCount || pageNum >= pageCount || exporting;
    jumpBtn.disabled = !pageCount || exporting;
    exportBtn.disabled = !doc || exporting;
  }

  async function goto(n) {
    if (!doc) return;
    const target = Math.min(Math.max(1, n), pageCount || 1);
    pageNum = target;
    syncPager();
    setStatus('');
    await renderPage(target);
  }

  // ===== 打开 PDF =====

  async function loadEntry(e) {
    if (!e) return;
    if (!isPdfName(e.name)) {
      setStatus('这里只收 PDF 文件：' + e.name, true);
      return;
    }
    setStatus('正在读取 PDF…');
    try {
      const lib = await ensurePdfjs();
      const bytes = await readEntryBytes(e);
      if (!bytes.length) {
        setStatus('这个 PDF 是空文件', true);
        return;
      }
      const task = lib.getDocument({ data: bytes });
      const d = await task.promise;
      const old = doc;
      doc = d;
      entry = e;
      pageCount = d.numPages;
      pageNum = 1;
      customDir = null;
      if (old) old.destroy().catch(() => {});
      const size = await fileSizeOf(e);
      nameEl.textContent = `${e.name} · ${pageCount} 页${size ? ' · ' + formatBytes(size) : ''}`;
      nameEl.title = e.path || e.name;
      openSrcBtn.disabled = !isTauri || !e.path;
      openDirBtn.disabled = true;
      syncDir();
      syncPager();
      syncExportLabel();
      setStatus('');
      await renderPage(1);
    } catch (err) {
      doc = null;
      pageCount = 0;
      syncPager();
      setStatus('PDF 打不开：' + (err?.message || err), true);
    }
  }

  openBtn.addEventListener('click', async () => {
    const list = await pickImages(false, ['pdf'], { title: '选择 PDF 文件', label: 'PDF 文件' });
    if (list.length) loadEntry(list[0]);
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
  window.addEventListener('resize', () => {
    if (!doc || zoomSel.value !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage(pageNum), 150);
  });

  fmtSel.addEventListener('change', applyQuality);
  qualityIn.addEventListener('input', () => {
    qualityNum.textContent = qualityIn.value;
  });

  browseBtn.addEventListener('click', async () => {
    const d = await resolveSaveDir(null);
    if (!d) return;
    customDir = d;
    syncDir();
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

  // ===== 导出 =====

  function selectedPages() {
    const mode = rangeBtns.find((b) => b.classList.contains('on'))?.dataset.range || 'all';
    if (mode === 'current') return [pageNum];
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  function syncExportLabel() {
    const mode = rangeBtns.find((b) => b.classList.contains('on'))?.dataset.range || 'all';
    exportBtn.textContent = mode === 'current' ? '导出当前页' : `导出全部 ${pageCount || 0} 页`;
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
    if (!doc || exporting) return;
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
    const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = fmt === 'jpg' ? 'jpg' : 'png';
    const quality = Math.min(1, Math.max(0.1, Number(qualityIn.value) / 100));
    // DPI 选项存的是相对 72 DPI 的倍率：300 DPI ≈ 4.17 倍
    const scale = Number(dpiSel.value);
    const stem = stemOf(entry?.name || 'page');
    const width = Math.max(3, String(pages.length).length);

    try {
      if (dir) await makeDir(dir);
      let done = 0;
      for (const n of pages) {
        if (cancelExport) break;
        const page = await doc.getPage(n);
        const off = await renderToCanvas(page, scale);
        const blob = await new Promise((res, rej) =>
          off.toBlob((b) => (b ? res(b) : rej(new Error('编码失败'))), mime, quality),
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const name = `${stem}_${String(n).padStart(width, '0')}.${ext}`;
        await saveBlob(name, bytes, dir);
        done += 1;
        setProgress((done / pages.length) * 100);
        setExportStatus(`正在导出 ${done}/${pages.length} 页…`);
        // 让出一帧，长文档不至于把界面卡住
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelExport) {
        setExportStatus(`已停止（已导出 ${done} 页）`);
      } else {
        setExportStatus(`导出完成：${done} 页 → ${dir || '浏览器下载'}`);
      }
      // 导出目录这时才是真的存在了，按钮才能点
      openDirBtn.disabled = !isTauri || !dir;
    } catch (err) {
      setExportStatus('导出失败：' + (err?.message || err), true);
    } finally {
      exporting = false;
      exportBtn.textContent = '导出';
      syncExportLabel();
      syncPager();
    }
  });

  // 导出中再点一次就是停止
  exportBtn.addEventListener('dblclick', () => {
    if (exporting) cancelExport = true;
  });

  applyQuality();
  syncDir();
  syncPager();
  syncExportLabel();

  return {
    loadEntry,
    // 拖进来的是一批文件，这一页一次只吃一个
    addEntries(entries) {
      if (entries && entries.length) loadEntry(entries[0]);
    },
  };
}
