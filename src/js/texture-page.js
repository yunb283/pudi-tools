import { dirname, isSupportedName, isTauri, pickImages, readEntryBytes, resolveSaveDir, saveBlob, stemOf, TEXTURE_EXTS } from './platform.js';
import { decodeToCanvas, extOf, FORMAT_NAME, humanSize, rgbaCanvas } from './decode.js';
import { canvasToImageData, encodeCanvas, imageOutputStem } from './image-util.js';
import { createIoButtons } from './io-buttons.js';
import { makeTexClient } from './tex-client.js';

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

export function texturePage({
  prefix, kind, suffix, srcView, options, compute, metricsOf, onSource, onResult, errorLabel, encodeResult,
}) {
  const field = (id) => document.getElementById(`${prefix}-${id}`);
  const exportBtn = field('export');
  const clearBtn = field('clear');
  const nameIn = field('name');
  const io = createIoButtons(field('io'), setStatus);

  let source = null;
  let ready = false;
  let loading = false;
  let exporting = false;
  let pending = false;
  let loadId = 0;
  let cached = null;

  function setStatus(message) {
    field('status').textContent = message;
  }

  function updateControls() {
    clearBtn.disabled = !source && !loading;
    exportBtn.disabled = !ready || loading || exporting;
  }

  function showSource() {
    const canvas = source?.canvas;
    srcView.setImage(canvas, canvas?.width, canvas?.height);
    field('info').textContent = canvas
      ? `图像尺寸：${canvas.width}x${canvas.height}  |  大小：${humanSize(source.bytes)}  |  格式：${FORMAT_NAME[extOf(source.name)] || '未知'}`
      : '图像尺寸：-  |  大小：-  |  格式：-';
    cached = null;
    onSource?.(source);
    onResult(null);
  }

  const client = makeTexClient({
    kind, compute, metricsOf,
    apply(result) {
      if (!source) return;
      if (!result.ok) {
        cached = null;
        onResult(null);
        if (!loading) setStatus(errorLabel + '：' + result.message);
        return;
      }
      const { width, height } = source.image;
      const canvas = rgbaCanvas(width, height, result.data);
      cached = { key: JSON.stringify(result.opts), canvas, data: encodeResult ? result.data : null };
      onResult({ ...result, canvas }, source);
      if (!loading && field('status').textContent.startsWith(errorLabel + '：')) {
        setStatus('已载入：' + source.name);
      }
    },
  });

  function schedule() {
    if (!ready || pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (ready) client.request(options());
    }, 0);
  }

  async function loadEntry(entry) {
    const id = ++loadId;
    if (!isSupportedName(entry.name, TEXTURE_EXTS)) {
      loading = false;
      updateControls();
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    loading = true;
    updateControls();
    setStatus('正在载入…');
    try {
      await nextTick();
      if (id !== loadId) return;
      const bytes = await readEntryBytes(entry);
      if (id !== loadId) return;
      if (!bytes.length) throw new Error('文件内容为空');
      const canvas = await decodeToCanvas(entry.name, bytes);
      if (id !== loadId) return;
      const image = canvasToImageData(canvas);
      const next = { name: entry.name, path: entry.path, bytes: bytes.length, canvas, image, metrics: null };
      source = next;
      ready = false;
      nameIn.value = '';
      showSource();
      io.setSource(entry.path);
      io.setExport(null);
      const metrics = await client.load(image);
      if (source !== next) return;
      next.metrics = metrics;
      ready = true;
      if (id === loadId) setStatus('已载入：' + entry.name);
      schedule();
    } catch (error) {
      if (id === loadId) setStatus('载入失败：' + (error?.message ?? error));
    } finally {
      if (id === loadId) loading = false;
      updateControls();
    }
  }

  function clearImage() {
    ++loadId;
    loading = ready = false;
    source = null;
    client.unload();
    nameIn.value = '';
    io.clear();
    showSource();
    updateControls();
    setStatus('');
  }

  async function exportTo() {
    if (!ready || loading || exporting) return;
    const current = source;
    const opts = options();
    const ext = field('fmt').value.toLowerCase();
    const stem = imageOutputStem(nameIn.value, stemOf(current.name), 'texture');
    const filename = (stem.toLowerCase().endsWith(suffix.toLowerCase()) ? stem : stem + suffix) + '.' + ext;
    const originalDir = field('save-orig').checked ? dirname(current.path) : null;
    exporting = true;
    updateControls();
    setStatus('正在导出…');
    try {
      let output;
      if (cached?.key === JSON.stringify(opts)) {
        output = cached;
      } else {
        const result = await client.request(opts, { exact: true });
        if (source !== current) return;
        if (!result?.ok) throw new Error(result?.message || '没有可导出的计算结果');
        output = encodeResult
          ? result
          : { canvas: rgbaCanvas(current.image.width, current.image.height, result.data) };
      }
      const dir = await resolveSaveDir(originalDir);
      if (source !== current) return;
      if (isTauri && !dir) {
        setStatus('已取消');
        return;
      }
      const bytes = encodeResult
        ? await encodeResult({ width: current.image.width, height: current.image.height, data: output.data }, ext)
        : await encodeCanvas(output.canvas, ext);
      if (source !== current) return;
      const saved = await saveBlob(filename, bytes, dir, { unique: true });
      if (source !== current) return;
      io.setExport(dir ? saved : null);
      setStatus(`已导出：${saved}（${humanSize(bytes.length)}）`);
    } catch (error) {
      if (source === current) setStatus('导出失败：' + (error?.message ?? error));
    } finally {
      exporting = false;
      updateControls();
    }
  }

  field('open').addEventListener('click', async () => {
    try {
      const entries = await pickImages(false, TEXTURE_EXTS);
      if (entries.length) await loadEntry(entries[0]);
    } catch (error) {
      setStatus('打开失败：' + (error?.message ?? error));
    }
  });
  clearBtn.addEventListener('click', clearImage);
  exportBtn.addEventListener('click', exportTo);

  return { loadEntry, schedule };
}

// Use the range control as the canonical clamped, step-aligned value.
export function linkTextureRange(range, number, schedule) {
  range.addEventListener('input', () => {
    number.value = range.value;
    schedule();
  });
  number.addEventListener('input', () => {
    if (!Number.isFinite(number.valueAsNumber)) return;
    range.value = number.value;
    schedule();
  });
  number.addEventListener('change', () => {
    number.value = range.value;
  });
}
