import { makeSeamless, seamBand, seamMetrics } from './seamless.js';
import { equalizeCanvases } from './layout.js';
import { linkTextureRange, texturePage } from './texture-page.js';

const $ = (id) => document.getElementById('sml-' + id);
const num = (v) => Number.isFinite(v) ? v.toFixed(2) : '—';

function inspectionCanvas(source, metrics, mode) {
  if (mode === 'image' || !metrics) return source;
  const canvas = document.createElement('canvas');
  const { width: w, height: h } = source;
  const offset = mode === 'offset';
  const scale = Math.min(1, (offset ? 2048 : 512) / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  const sw = canvas.width;
  const sh = canvas.height;
  if (offset) {
    const x = Math.round(Math.floor(w / 2) / w * sw);
    const y = Math.round(Math.floor(h / 2) / h * sh);
    for (const dx of [x - sw, x]) {
      for (const dy of [y - sh, y]) ctx.drawImage(source, dx, dy, sw, sh);
    }
    return canvas;
  }

  ctx.drawImage(source, 0, 0, sw, sh);
  ctx.fillStyle = 'rgba(13, 17, 24, .82)';
  ctx.fillRect(0, 0, sw, sh);
  const max = mode === 'color' ? Math.sqrt(3) * 255 : 255;
  const lr = metrics.edges[mode + 'LR'];
  const tb = metrics.edges[mode + 'TB'];
  const thickness = Math.max(1, Math.round(Math.min(sw, sh) / 80));
  function drawLine(samples, length, vertical) {
    for (let i = 0; i < length; i++) {
      const end = Math.ceil((i + 1) * samples.length / length);
      let diff = 0;
      for (let j = Math.floor(i * samples.length / length); j < end; j++) diff = Math.max(diff, samples[j]);
      if (!diff) continue;
      const strength = Math.sqrt(diff / max);
      ctx.fillStyle = `rgba(255, ${Math.round(218 * strength)}, 35, ${0.4 + 0.6 * strength})`;
      if (vertical) {
        ctx.fillRect(0, i, thickness, 1);
        ctx.fillRect(sw - thickness, i, thickness, 1);
      } else {
        ctx.fillRect(i, 0, 1, thickness);
        ctx.fillRect(i, sh - thickness, 1, thickness);
      }
    }
  }
  drawLine(lr, sh, true);
  drawLine(tb, sw, false);
  return canvas;
}

function bandText(options, w, h) {
  const axes = [];
  if (options.dir !== 'v') axes.push({ name: '横', length: w, band: seamBand(w, options.blend) });
  if (options.dir !== 'h') axes.push({ name: '纵', length: h, band: seamBand(h, options.blend) });
  if (axes.every((axis) => axis.band === 0)) return '0px';
  const bands = axes.map((axis) => `${axis.name}${axis.band}px`).join(' ');
  if (!options.levels) return bands;
  const radius = axes.map(({ name, length, band }) =>
    `${name}${Math.min(length >> 2, band * (1 << (options.levels - 1)))}px`).join(' ');
  return `${bands} · 低频半径 ${radius}`;
}

export function initSeamless({ srcView, outView }) {
  const protectBtn = $('protect');
  const clearProtectBtn = $('protect-clear');
  const outInfo = $('out-info');
  const metricLabel = $('metric');
  let source = null;
  let result = null;
  let protection = null;
  let selecting = false;
  let displayedSource = null;

  equalizeCanvases(document.getElementById('page-seamless'));
  srcView.syncNavigation(outView);

  function showPreviews() {
    const mode = $('inspect').value;
    const tile = selecting || mode === 'offset' ? 1 : Number($('tile').value);
    const leftMode = selecting ? 'image' : mode;
    if (displayedSource?.source !== source || displayedSource?.mode !== leftMode ||
        displayedSource?.metrics !== source?.metrics) {
      const canvas = source ? inspectionCanvas(source.canvas, source.metrics, leftMode) : null;
      displayedSource = { source, mode: leftMode, metrics: source?.metrics };
      srcView.setImage(canvas, source?.canvas.width, source?.canvas.height);
    }
    srcView.setTile(tile);
    srcView.setSelect(selecting ? protection : null);
    outView.setTile(tile);
    const out = result ? inspectionCanvas(result.canvas, result.metrics, mode) : null;
    outView.setImage(out, result?.canvas.width, result?.canvas.height);
    $('heat-hint').hidden = mode !== 'color' && mode !== 'alpha';
    outInfo.textContent = result
      ? `结果尺寸：${result.canvas.width}x${result.canvas.height}  |  平铺 ${tile}x${tile}  |  融合带 ${bandText(result.opts, result.canvas.width, result.canvas.height)}  |  ${result.ms.toFixed(result.ms < 10 ? 1 : 0)}ms`
      : '结果尺寸：-  |  融合带：-  |  耗时：-';
  }

  function selectMode(on) {
    selecting = on;
    protectBtn.setAttribute('aria-pressed', String(on));
    protectBtn.classList.toggle('on', on);
    $('protect-hint').hidden = !on;
    srcView.setPanEnabled(!on);
    srcView.setSelectEnabled(on);
    showPreviews();
  }

  const page = texturePage({
    prefix: 'sml', kind: 'seamless', suffix: '_Seamless', srcView,
    errorLabel: '无缝化失败',
    options: () => ({
      blend: Number($('width').value) / 100,
      dir: $('dir').value,
      keepAlpha: $('keep-alpha').checked,
      levels: Number($('levels').value),
      region: protection,
      regionMode: $('mask-mode').value,
    }),
    compute(image, options) {
      const data = makeSeamless(image, options);
      return { data, metrics: seamMetrics({ width: image.width, height: image.height, data }) };
    },
    metricsOf: seamMetrics,
    onSource(next) {
      source = next;
      result = protection = null;
      protectBtn.disabled = !next;
      clearProtectBtn.disabled = true;
      $('mask-mode').disabled = !next;
      selectMode(false);
    },
    onResult(next) {
      result = next ? { canvas: next.canvas, metrics: next.metrics, opts: next.opts, ms: next.ms } : null;
      showPreviews();
      const before = source?.metrics;
      const after = result?.metrics;
      if (!before || !after) {
        metricLabel.textContent = '接缝指标：-';
        return;
      }
      metricLabel.textContent =
        `颜色差（左右 / 上下） ${num(before.lr)} → ${num(after.lr)} / ${num(before.tb)} → ${num(after.tb)}\n` +
        `透明度差（左右 / 上下） ${num(before.lrAlpha)} → ${num(after.lrAlpha)} / ${num(before.tbAlpha)} → ${num(after.tbAlpha)}\n` +
        `边缘色差 / 内部梯度 ${num(before.ratio)} → ${num(after.ratio)}`;
    },
  });

  srcView.setSelectEnabled(false);
  srcView.onSelectEnd = (selection) => {
    protection = selection;
    clearProtectBtn.disabled = !selection;
    page.schedule();
  };
  protectBtn.addEventListener('click', () => selectMode(!selecting));
  clearProtectBtn.addEventListener('click', () => {
    protection = null;
    srcView.setSelect(null);
    clearProtectBtn.disabled = true;
    page.schedule();
  });
  linkTextureRange($('width'), $('width-num'), page.schedule);
  for (const id of ['keep-alpha', 'dir', 'levels', 'mask-mode']) $(id).addEventListener('change', page.schedule);
  for (const id of ['tile', 'inspect']) $(id).addEventListener('change', showPreviews);
  return page;
}
