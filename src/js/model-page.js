import {
  isTauri, dirname, baseName, stemOf, readEntryBytes, pickImages, resolveSaveDir, saveBlob,
  MODEL_EXTS, MODEL_ASSET_EXTS, isModelName,
} from './platform.js';
import { encodeCanvas } from './image-util.js';

const $ = (id) => document.getElementById(id);
const extension = (name) => name.split('.').pop().toLowerCase();
const TEXTURE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'dds', 'tga', 'targa', 'tif', 'tiff'];
const MODEL_PICK_EXTS = [...new Set([...MODEL_EXTS, ...MODEL_ASSET_EXTS])];

function siblingReader(entry, siblings) {
  const selected = new Map(siblings.map((file) => [file.name.toLowerCase(), file]));
  const dir = dirname(entry.path);
  return async (uri) => {
    let relative = String(uri).split(/[?#]/, 1)[0];
    try { relative = decodeURIComponent(relative); } catch (_) { /* 保留原始文件名 */ }
    relative = relative.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!relative || /^(\/|[a-z][a-z\d+.-]*:)/i.test(relative) || relative.split('/').includes('..')) return null;
    const name = baseName(relative);
    const file = selected.get(relative.toLowerCase()) || selected.get(name.toLowerCase());
    try {
      if (file) return await readEntryBytes(file);
      if (isTauri && dir) {
        const path = dir + '\\' + relative.replace(/\//g, '\\');
        return await readEntryBytes({ name, path });
      }
    } catch (_) { /* 加载器负责提示缺失的外部资源 */ }
    return null;
  };
}

async function readTexture(entry) {
  const ext = extension(entry.name);
  const bytes = await readEntryBytes(entry);
  let decoded;
  if (ext === 'tga' || ext === 'targa') {
    const { decodeTga } = await import('./tga.js');
    decoded = decodeTga(bytes);
  } else if (ext === 'dds') {
    const { decodeDds } = await import('./dds.js');
    decoded = decodeDds(bytes);
  } else if (ext === 'tif' || ext === 'tiff') {
    const { decodeTiff } = await import('./tiff.js');
    decoded = await decodeTiff(bytes);
  }
  const source = decoded
    ? new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height)
    : new Blob([bytes]);
  return { bitmap: await createImageBitmap(source), name: entry.name };
}

export function initModelPage() {
  const page = $('page-model');
  const stage = $('mv-stage');
  const status = $('mv-status');
  const hint = $('mv-hint');
  const rendererChoice = $('mv-renderer');
  const webglCanvas = $('mv-canvas');
  const webglBar = $('mv-webgl-bar');
  const webglInfo = $('mv-webgl-info');
  const help = $('mv-help');
  const uvExport = $('mv-uv-export-dialog');
  const isVisible = () => !page.classList.contains('hidden');
  let webgl, fast, drawUvExport, current;
  let mode = null;
  let queue = Promise.resolve();
  let exportData;

  function setStatus(message, warn = false) {
    status.textContent = message;
    status.classList.toggle('warn', warn);
  }

  async function saveImage(filename, makeBytes) {
    try {
      const bytes = await makeBytes();
      const dir = await resolveSaveDir(null);
      if (isTauri && !dir) return;
      const saved = await saveBlob(filename, bytes, dir);
      if (saved) setStatus('已导出：' + saved);
    } catch (err) {
      setStatus('导出失败：' + (err.message || err), true);
    }
  }

  function showUvExport(data) {
    exportData = data;
    const channel = $('mv-uv-export-channel');
    channel.replaceChildren(...data.channels.map((set, index) => new Option(set.name, String(index))));
    channel.value = String(data.selectedChannel);
    uvExport.returnValue = '';
    uvExport.showModal();
  }

  uvExport.addEventListener('close', () => {
    const data = exportData;
    exportData = null;
    if (!data || uvExport.returnValue !== 'export') return;
    const ext = $('mv-uv-export-format').value;
    const size = Number($('mv-uv-export-size').value);
    const edges = $('mv-uv-export-edges').value;
    const uv = data.channels[Number($('mv-uv-export-channel').value)].uv;
    saveImage(`${stemOf(data.name)}-uv.${ext}`, () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      drawUvExport(canvas.getContext('2d'), uv, data.positions, size, edges);
      return encodeCanvas(canvas, ext);
    });
  });
  async function getFastView() {
    const [core, view, uv] = await Promise.all([
      import('./model-preview/model3d.js'),
      import('./model-preview/model-view.js'),
      import('./model-preview/model-uv.js'),
    ]);
    if (fast) return core.MODEL_EXTS;
    drawUvExport = uv.drawUvExport;
    fast = view.createModelView({
      canvas: $('mv-fast-canvas'), stage, isVisible, info: $('mv-fast-info'), viewSelect: $('mv-fast-view'),
      bar: $('mv-fast-bar'), uvBar: $('mv-uv-bar'), animBar: $('mv-anim-bar'),
      buttons: {
        solid: $('mv-solid'), wire: $('mv-fast-wire'), both: $('mv-both'),
        grid: $('mv-fast-grid'), spin: $('mv-fast-rotate'), origin: $('mv-origin'),
        flat: $('mv-flat'), smooth: $('mv-smooth'), vertices: $('mv-vertices'), normals: $('mv-normals'),
      },
      animControls: {
        take: $('mv-take'), play: $('mv-play'), first: $('mv-first'), prev: $('mv-prev'),
        next: $('mv-next'), timeline: $('mv-timeline'), time: $('mv-time'), unit: $('mv-unit'),
      },
      uvPanel: $('mv-uv-panel'),
      uvControls: {
        proj: $('mv-projection'), wire: $('mv-uv-wire'), view: $('mv-uv-view'), set: $('mv-uv-set'),
        tex: $('mv-texture'), clearTex: $('mv-texture-clear'), alpha: $('mv-texture-alpha'),
        elemV: $('mv-uv-vertex'), elemE: $('mv-uv-edge'), elemF: $('mv-uv-face'), elemI: $('mv-uv-island'),
        canvas: $('mv-uv-canvas'), panel: $('mv-uv-panel'), grip: $('mv-uv-grip'), panelX: $('mv-uv-close'),
        panelName: $('mv-uv-name'), panelInfo: $('mv-uv-info'), exportUv: $('mv-uv-export'),
        infoBody: $('mv-fast-stats'), msg: $('mv-uv-status'),
      },
      async onImportTexture() {
        const [entry] = await pickImages(false, TEXTURE_EXTS, { title: '选择贴图', label: '贴图图片' });
        return entry ? readTexture(entry) : null;
      },
      onExportUv: showUvExport,
    });
    return core.MODEL_EXTS;
  }

  function showWebgl(show) {
    webglCanvas.hidden = webglBar.hidden = webglInfo.hidden = !show;
    if (show) webgl.redraw();
    else if (mode === 'webgl') webgl.clear();
  }

  async function openModel(entry, siblings, preference) {
    rendererChoice.disabled = true;
    try {
      setStatus('正在读取 ' + entry.name + ' …');
      const bytes = await readEntryBytes(entry);
      if (!bytes.length) throw new Error('文件内容为空');
      const ext = extension(entry.name);
      let loaded = null;
      let fastError = null;
      if (preference === 'auto') {
        try {
          const extensions = await getFastView();
          if (extensions.includes(ext)) {
            setStatus('正在解析 ' + entry.name + ' …');
            loaded = await fast.load({ bytes, ext, name: entry.name, resolveUri: siblingReader(entry, siblings) });
          }
        } catch (err) {
          fastError = err;
          console.info('[model-preview] Canvas 2D 载入失败，尝试 WebGL', err);
        }
      }
      if (loaded) {
        showWebgl(false);
        mode = 'fast';
        const total = loaded.triangles.toLocaleString('zh-CN');
        setStatus(`已载入 ${entry.name} · ${total} 三角面 · 流畅预览`);
      } else {
        if (!webgl) {
          const { initModelWebgl } = await import('./model-webgl.js');
          webgl = initModelWebgl();
        }
        if (!await webgl.loadEntry(entry, siblings, bytes)) {
          if (fastError) setStatus('载入失败：' + (fastError.message || fastError) + ' · ' + status.textContent, true);
          return false;
        }
        if (mode === 'fast') fast.dispose();
        showWebgl(true);
        mode = 'webgl';
        if (preference === 'auto') status.append(' · 已切换至 WebGL');
      }
      current = { entry, siblings, preference };
      $('mv-file').textContent = entry.name;
      hint.hidden = true;
      return true;
    } catch (err) {
      setStatus('载入失败：' + (err.message || err), true);
      return false;
    } finally {
      rendererChoice.disabled = false;
    }
  }

  function loadEntry(entry, siblings = []) {
    if (!entry) return queue;
    const preference = rendererChoice.value;
    queue = queue.then(async () => {
      if (isModelName(entry.name)) {
        await openModel(entry, siblings, preference);
      } else if (mode === 'fast' && TEXTURE_EXTS.includes(extension(entry.name))) {
        try {
          fast.applyTexture(await readTexture(entry));
        } catch (err) {
          setStatus('贴图导入失败：' + (err.message || err), true);
        }
      } else {
        setStatus('不是支持的 3D 格式：' + entry.name, true);
      }
    });
    return queue;
  }

  rendererChoice.addEventListener('change', () => {
    if (!current) return;
    rendererChoice.disabled = true;
    queue = queue.then(async () => {
      const { entry, siblings, preference } = current;
      if (!await openModel(entry, siblings, rendererChoice.value)) rendererChoice.value = preference;
    });
  });
  $('mv-open').addEventListener('click', async () => {
    try {
      const entries = await pickImages(true, MODEL_PICK_EXTS, {
        title: '选择 3D 模型（可同时选择贴图、.bin 和 .mtl）', label: '3D 模型与配套资源',
      });
      const entry = entries.find((file) => isModelName(file.name));
      if (entry) loadEntry(entry, entries.filter((file) => file !== entry));
      else if (entries.length) setStatus('请选择一个支持的 3D 模型', true);
    } catch (err) {
      setStatus('打开失败：' + (err.message || err), true);
    }
  });
  $('mv-reset').addEventListener('click', () => {
    if (mode === 'fast') fast.reset();
    if (mode === 'webgl') webgl.reset();
  });
  $('mv-shot').addEventListener('click', () => {
    if (!current) return setStatus('先载入一个模型再导出截图', true);
    const view = mode === 'fast' ? fast : webgl;
    saveImage(stemOf(current.entry.name) + '-preview.png', async () => {
      const blob = await view.capture();
      if (!blob) throw new Error('PNG 编码失败');
      return new Uint8Array(await blob.arrayBuffer());
    });
  });
  $('mv-help-formats').textContent = MODEL_EXTS.map((ext) => '.' + ext).join('、');
  $('mv-help-open').addEventListener('click', () => help.showModal());
  page.addEventListener('keydown', (e) => {
    if (mode !== 'fast' || e.target.closest('input, select, textarea, button, dialog, [contenteditable]')) return;
    fast.key(e);
  });

  return {
    loadEntry,
    redraw() {
      if (!isVisible()) return;
      if (mode === 'fast') fast.redraw();
      if (mode === 'webgl') webgl.redraw();
    },
  };
}
