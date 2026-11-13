import { heightToNormal } from './normal.js';
import { equalizeCanvases } from './layout.js';
import { linkTextureRange, texturePage } from './texture-page.js';
import { encodeTga } from './tga.js';

const $ = (id) => document.getElementById('nrm-' + id);

export function initNormal({ srcView, outView }) {
  const outInfo = $('out-info');
  const lightBtn = $('light');
  const angle = $('light-angle');
  const black = $('black');
  const white = $('white');
  let levels = { black: 0, white: 255 };
  let result = null;
  let sample = null;
  let lightCanvas = null;
  let frame = 0;

  equalizeCanvases(document.getElementById('page-normal'));

  function showPreview() {
    if (!result) {
      outView.setImage(null);
      return;
    }
    const canvas = result.canvas;
    if (lightBtn.getAttribute('aria-pressed') === 'false') {
      outView.setImage(canvas, canvas.width, canvas.height);
      return;
    }
    if (!sample) {
      const scale = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
      lightCanvas = document.createElement('canvas');
      lightCanvas.width = Math.max(1, Math.round(canvas.width * scale));
      lightCanvas.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = lightCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, lightCanvas.width, lightCanvas.height);
      sample = ctx.getImageData(0, 0, lightCanvas.width, lightCanvas.height);
    }
    const ctx = lightCanvas.getContext('2d');
    const lit = ctx.createImageData(sample.width, sample.height);
    const radians = Number(angle.value) * Math.PI / 180;
    const lx = Math.cos(radians) * 0.8;
    const ly = -Math.sin(radians) * 0.8 * (result.opts.yUp ? 1 : -1);
    for (let i = 0; i < sample.data.length; i += 4) {
      const nx = sample.data[i] / 127.5 - 1;
      const ny = sample.data[i + 1] / 127.5 - 1;
      const nz = sample.data[i + 2] / 127.5 - 1;
      const shade = 54 + 196 * Math.max(0, Math.min(1, nx * lx + ny * ly + nz * 0.6));
      lit.data[i] = shade;
      lit.data[i + 1] = shade;
      lit.data[i + 2] = shade;
      lit.data[i + 3] = sample.data[i + 3];
    }
    ctx.putImageData(lit, 0, 0);
    outView.setImage(lightCanvas, canvas.width, canvas.height);
  }

  function updateLight(active) {
    lightBtn.classList.toggle('on', active);
    lightBtn.setAttribute('aria-pressed', String(active));
    $('light-angle-row').hidden = !active;
    showPreview();
  }

  const page = texturePage({
    prefix: 'nrm', kind: 'normal', suffix: '_Normal', srcView,
    errorLabel: '生成失败',
    options: () => ({
      source: $('source').value,
      invert: $('invert').checked,
      blur: Number($('blur').value),
      strength: Number($('strength').value),
      yUp: $('convention').value === 'og',
      boundary: $('boundary').value,
      alpha: $('alpha').value,
      ...levels,
    }),
    compute: (image, options) => ({ data: heightToNormal(image, options) }),
    async encodeResult(image, ext) {
      if (ext === 'tga') return encodeTga({ ...image, data: image.data.slice() });
      const { encodeRgbaPng } = await import('./rgba-png.js');
      return encodeRgbaPng(image);
    },
    onResult(next) {
      result = next ? { canvas: next.canvas, opts: next.opts } : null;
      sample = lightCanvas = null;
      lightBtn.disabled = !next;
      outInfo.textContent = next
        ? `法线尺寸：${next.canvas.width}x${next.canvas.height}  |  生成耗时：${next.ms.toFixed(next.ms < 10 ? 1 : 0)}ms`
        : '法线尺寸：-  |  生成耗时：-';
      showPreview();
    },
  });

  for (const id of ['blur', 'strength']) linkTextureRange($(id), $(id + '-num'), page.schedule);
  for (const id of ['source', 'invert', 'convention', 'boundary', 'alpha']) $(id).addEventListener('change', page.schedule);
  for (const field of [black, white]) {
    function updateLevel() {
      if (!Number.isFinite(field.valueAsNumber)) return;
      if (field === black) {
        levels.black = Math.max(0, Math.min(levels.white - 1, Math.round(field.valueAsNumber)));
      } else {
        levels.white = Math.min(255, Math.max(levels.black + 1, Math.round(field.valueAsNumber)));
      }
      page.schedule();
    }
    field.addEventListener('input', updateLevel);
    field.addEventListener('change', () => {
      updateLevel();
      field.value = field === black ? levels.black : levels.white;
    });
  }
  lightBtn.addEventListener('click', () => updateLight(lightBtn.getAttribute('aria-pressed') === 'false'));
  angle.addEventListener('input', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      showPreview();
    });
  });

  return page;
}
