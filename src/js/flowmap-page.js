// Flowmap 绘制页：把 FlowmapCanvas（Python / OpenGL）的核心思路搬到 Web 上。
//   · 数据：Uint8Array(W*H*2)，R=X 方向、G=Y 方向，中性色 (128,128,0)，导出时补 B=0 / A=255
//   · 笔刷：lerp 渐进叠加 dst += (target-dst) * (falloff² * strength)，不是覆盖也不是加法累加
//   · 四方连续：主笔刷 + 最多 8 个 ±W/±H 镜像笔刷，天然跨边界连续
//   · 预览：移植 flow_shader.glsl 的双相位错开 0.5 采样 + 三角权重混合（WebGL1）
//   · 撤销：32×32 tile 脏块快照，4096² 画布也不会因为整张复制吃满内存
import {
  pickImages,
  readEntryBytes,
  saveBlob,
  resolveSaveDir,
  uniqueFilename,
  isTauri,
  isSupportedName,
  TEXTURE_EXTS,
} from './platform.js';
import { decodeToCanvas, humanSize } from './decode.js';
import { canvasToBlob, encodeCanvas } from './image-util.js';
import {
  NEUTRAL, FLOW_SIZES, wrap, decodeFlow, encodeFlow, flipFlow, featherFlow,
  resizeFlow, packFlowProject, unpackFlowProject,
} from './flowmap-data.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TILE = 32; // 撤销快照的方块边长（纹理像素）
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 与原版 flow_shader.glsl 同源；纹理不翻转、UV 原点在左上，故 Y 方向额外取反一次
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFlow;
uniform sampler2D uBase;
uniform float uTime;
uniform float uSpeed;
uniform float uDist;
uniform float uScale;
uniform float uDirectX;
uniform float uMode;
uniform float uRepeat;
uniform float uBorder;
uniform float uHasBase;
uniform float uTiles;
uniform vec2 uUvShift;
uniform float uUvWrap;

// UV 动画开启时强制循环采样，否则底图滑出边界会被拉伸成一条边
vec2 wrapUV(vec2 v) {
  return (uRepeat > 0.5 || uUvWrap > 0.5) ? fract(v) : clamp(v, vec2(0.0), vec2(1.0));
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 tuv = uv * uTiles;
  vec2 suv = (uRepeat > 0.5) ? fract(tuv) : clamp(tuv, vec2(0.0), vec2(1.0));
  vec2 rg = texture2D(uFlow, suv).rg;

  if (uMode > 1.5) {                       // 仅底图
    vec2 b = uv / uScale * uTiles + uUvShift;
    gl_FragColor = vec4(texture2D(uBase, wrapUV(b)).rgb, 1.0);
    return;
  }
  if (uMode > 0.5 || uHasBase < 0.5) {     // 原始 RG 编码（底图缺失时也退回它）
    gl_FragColor = vec4(rg, 0.0, 1.0);
    return;
  }

  vec2 signedByte = rg * 255.0 - 128.0;
  vec2 dir = signedByte / mix(vec2(128.0), vec2(127.0), step(vec2(0.0), signedByte));
  dir.x = -dir.x;                          // 采样偏移反向，内容才会顺着笔触流动
  dir.y = -dir.y;                          // 屏幕 / 纹理 Y 向下
  if (uDirectX > 0.5) dir.y = -dir.y;      // DirectX 约定：G 通道再翻一次

  float phase = uTime * uSpeed;
  float p0 = fract(phase);
  float p1 = fract(phase + 0.5);
  vec2 buv = uv / uScale * uTiles + uUvShift;
  vec2 s0 = wrapUV(buv + dir * p0 * uDist);
  vec2 s1 = wrapUV(buv + dir * p1 * uDist);
  vec3 c0 = texture2D(uBase, s0).rgb;
  vec3 c1 = texture2D(uBase, s1).rgb;
  vec3 col = mix(c0, c1, abs((0.5 - p0) / 0.5));

  if (uBorder > 0.5) {                     // 平铺边界框（原版是 0.002 宽的黄线）
    vec2 f = abs(fract(tuv) - 0.5);
    if (max(f.x, f.y) > 0.497) col = vec3(1.0, 0.85, 0.1);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function initFlowmap() {
  const page = $('page-flowmap');
  const stage = $('fm-stage');
  const canvas = $('fm-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = $('fm-status');
  const infoEl = $('fm-info');
  const historyEl = $('fm-history');
  const preview = $('fm-preview');
  const previewWrap = $('fm-preview-wrap');

  // ---------- 数据 ----------
  let W = 1024;
  let H = 1024;
  let data; // Uint8Array(W*H*2)
  let disp; // 显示 / 导出 / WebGL 纹理共用的 RGBA canvas
  let dispCtx;
  let dispImg;
  let tilesX = 1;
  let tilesY = 1;
  let dirty = null;
  let flowTexDirty = true;
  let previewDirty = true;
  let frameRequest = 0;
  let baseCanvas = null;
  let basePot = null;
  let baseCustom = false;
  let defaultBase = null;
  let selection = null;
  let clipboard = null;
  let fileBusy = false;
  let hasContent = false;

  // ---------- 视图 ----------
  const view = { scale: 1, ox: 0, oy: 0 };
  const cursor = { x: 0, y: 0, inside: false, dir: null };
  let drawScheduled = true;
  let fitted = false; // 页面初始是 hidden，等它真正有尺寸了再自动适配一次
  let userAdjustedView = false; // 用户手动缩放/平移之后不再自动改视图
  let lastStageW = 0;
  let lastStageH = 0;
  let bgColor = '#14161a';
  let arrowColor = '#eaf6fb';

  // ---------- 绘制状态 ----------
  let tool = 'draw';
  let pointer = null;
  let lastPoint = null;
  let spaceDown = false;
  let shiftDown = false;

  // ---------- 撤销（tile 快照） ----------
  let opBefore = null;
  let opChanged = false;
  const undoStack = [];
  const redoStack = [];
  let historyBytes = 0;

  // ---------- 预览 / 动画 ----------
  let gl = null;
  let glOK = false;
  let fallback = null;
  let prog = null;
  let uni = {};
  let flowTex = null;
  let baseTex = null;
  let animTime = 0;
  let playing = true;
  let lastTs = 0;
  let fpsFrames = 0;
  let fpsTs = 0;

  const setStatus = (msg) => {
    statusEl.textContent = msg || '';
  };
  const num = (id) => Number($(id).value) || 0;
  const checked = (id) => $(id).checked;
  function scheduleFrame() {
    if (!frameRequest && !page.classList.contains('hidden') && !document.hidden) {
      frameRequest = requestAnimationFrame(frame);
    }
  }
  const requestDraw = () => {
    drawScheduled = true;
    scheduleFrame();
  };
  const requestPreview = () => {
    previewDirty = true;
    scheduleFrame();
  };

  function syncThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    bgColor = cs.getPropertyValue('--bg-canvas2').trim() || '#14161a';
    arrowColor = cs.getPropertyValue('--text-bar').trim() || '#eaf6fb';
    requestDraw();
  }

  // ===== 数据初始化 / 显示缓冲 =====
  function rebuildDisplay() {
    const d = dispImg.data;
    for (let i = 0, p = 0; i < W * H; i++, p += 2) {
      const o = i * 4;
      d[o] = data[p];
      d[o + 1] = data[p + 1];
      d[o + 2] = 0;
      d[o + 3] = 255;
    }
    dispCtx.putImageData(dispImg, 0, 0);
    dirty = null;
    flowTexDirty = true;
    requestPreview();
    updateSeams();
    requestDraw();
  }

  function markDirty(x0, y0, x1, y1) {
    if (!dirty) dirty = { x0, y0, x1, y1 };
    else {
      if (x0 < dirty.x0) dirty.x0 = x0;
      if (y0 < dirty.y0) dirty.y0 = y0;
      if (x1 > dirty.x1) dirty.x1 = x1;
      if (y1 > dirty.y1) dirty.y1 = y1;
    }
  }

  function flushDirty() {
    if (!dirty) return;
    const { x0, y0, x1, y1 } = dirty;
    dirty = null;
    const d = dispImg.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * W + x) * 2;
        const o = (y * W + x) * 4;
        d[o] = data[p];
        d[o + 1] = data[p + 1];
      }
    }
    dispCtx.putImageData(dispImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
    flowTexDirty = true;
    requestPreview();
    updateSeams();
  }

  function initData(size, pixels) {
    finishPointer();
    W = H = size;
    tilesX = Math.ceil(W / TILE);
    tilesY = Math.ceil(H / TILE);
    data = pixels ? pixels.slice() : new Uint8Array(W * H * 2).fill(NEUTRAL);
    hasContent = !!pixels;
    selection = null;
    clipboard = null;
    disp = document.createElement('canvas');
    disp.width = W;
    disp.height = H;
    dispCtx = disp.getContext('2d', { willReadFrequently: true });
    dispImg = dispCtx.createImageData(W, H);
    undoStack.length = 0;
    redoStack.length = 0;
    historyBytes = 0;
    opBefore = null;
    rebuildDisplay();
    updateHistoryLabel();
    syncSelection();
    userAdjustedView = false;
    fitView();
  }

  // ===== 撤销：按 32×32 tile 保存笔触前后的像素 =====
  function saveTile(map, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) return;
    const key = ty * tilesX + tx;
    if (map.has(key)) return;
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    const w = Math.min(TILE, W - x0);
    const h = Math.min(TILE, H - y0);
    const buf = new Uint8Array(w * h * 2);
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * W + x0) * 2;
      buf.set(data.subarray(src, src + w * 2), y * w * 2);
    }
    map.set(key, { tx, ty, w, h, buf });
  }

  function markTiles(x0, y0, x1, y1, map) {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
        saveTile(map, tx, ty);
      }
    }
  }

  function snapshotFrom(before) {
    const after = new Map();
    for (const [key, t] of before) {
      saveTile(after, t.tx, t.ty);
      if (t.buf.every((value, i) => value === after.get(key).buf[i])) {
        before.delete(key);
        after.delete(key);
      }
    }
    return after;
  }

  function tilesBytes(map) {
    let n = 0;
    for (const t of map.values()) n += t.buf.length;
    return n;
  }

  function restoreTiles(map) {
    for (const t of map.values()) {
      for (let y = 0; y < t.h; y++) {
        const dst = ((t.ty * TILE + y) * W + t.tx * TILE) * 2;
        data.set(t.buf.subarray(y * t.w * 2, (y + 1) * t.w * 2), dst);
      }
    }
    rebuildDisplay();
  }

  function updateHistoryLabel() {
    historyEl.textContent = `历史：${undoStack.length} 步 / 可重做 ${redoStack.length} 步`;
    $('fm-undo').disabled = undoStack.length === 0;
    $('fm-redo').disabled = redoStack.length === 0;
  }

  function pushHistory(before, after) {
    const entry = { before, after };
    undoStack.push(entry);
    for (const old of redoStack) historyBytes -= tilesBytes(old.before) + tilesBytes(old.after);
    redoStack.length = 0;
    historyBytes += tilesBytes(before) + tilesBytes(after);
    while (historyBytes > MAX_HISTORY_BYTES && undoStack.length > 1) {
      const old = undoStack.shift();
      historyBytes -= tilesBytes(old.before) + tilesBytes(old.after);
    }
    updateHistoryLabel();
  }

  function beginOp() {
    opBefore = new Map();
    opChanged = false;
  }

  function endOp() {
    if (!opBefore) return;
    if (opChanged) {
      const after = snapshotFrom(opBefore);
      if (after.size) {
        hasContent = true;
        pushHistory(opBefore, after);
      }
    }
    opBefore = null;
    opChanged = false;
  }

  function undo() {
    if (fileBusy) return;
    finishPointer();
    if (!undoStack.length) return;
    const h = undoStack.pop();
    restoreTiles(h.before);
    redoStack.push(h);
    updateHistoryLabel();
    setStatus('已撤销');
  }

  function redo() {
    if (fileBusy) return;
    finishPointer();
    if (!redoStack.length) return;
    const h = redoStack.pop();
    restoreTiles(h.after);
    undoStack.push(h);
    updateHistoryLabel();
    setStatus('已重做');
  }

  // ===== 笔刷 =====
  function stamp(cx, cy, radius, strength, tr, tg, mode) {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(W, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(H, Math.ceil(cy + radius));
    if (x1 <= x0 || y1 <= y0) return;
    const region = selection;
    const allowed = (x, y) => !region || (x >= region.x && y >= region.y &&
      x < region.x + region.w && y < region.y + region.h &&
      (!region.mask || region.mask[(y - region.y) * region.w + x - region.x]));
    if (opBefore) markTiles(x0, y0, x1, y1, opBefore);
    let changed = false;
    function write(x, y, r, g) {
      const p = (y * W + x) * 2;
      if (data[p] === r && data[p + 1] === g) return;
      data[p] = r;
      data[p + 1] = g;
      changed = true;
    }

    if (mode === 'blur') {
      // 柔化：核半径跟着笔刷走（原来固定 5×5，笔刷 40px 时几乎抹不动），
      // 用积分图一次算出 2D 盒式均值，核再大也不会把每像素的开销带上去。
      // 混合量与「流动强度」解绑：旧写法直接乘 5/100 的渐进笔刷系数，
      // 中心只混进 3% 的邻域均值，看不出效果；现在最弱也有约 0.45。
      // 再往中性色轻轻拉一点，方向本来就均匀的区域也能看出被抹淡。
      const k = clamp(Math.round(radius * 0.3), 3, 20);
      const halo = k + 1;
      const bw = x1 - x0 + halo * 2;
      const bh = y1 - y0 + halo * 2;
      const iw = bw + 1;
      const ir = new Float64Array(iw * (bh + 1));
      const ig = new Float64Array(iw * (bh + 1));
      const xs = new Int32Array(bw);
      const ys = new Int32Array(bh);
      const tiled = checked('fm-seamless');
      for (let i = 0; i < bw; i++) xs[i] = tiled ? wrap(x0 - halo + i, W) : clamp(x0 - halo + i, 0, W - 1);
      for (let i = 0; i < bh; i++) ys[i] = tiled ? wrap(y0 - halo + i, H) : clamp(y0 - halo + i, 0, H - 1);
      for (let py = 0; py < bh; py++) {
        let rowR = 0;
        let rowG = 0;
        const rowBase = ys[py] * W;
        const cur = (py + 1) * iw;
        const prev = py * iw;
        for (let px = 0; px < bw; px++) {
          const p = (rowBase + xs[px]) * 2;
          rowR += data[p];
          rowG += data[p + 1];
          ir[cur + px + 1] = ir[prev + px + 1] + rowR;
          ig[cur + px + 1] = ig[prev + px + 1] + rowG;
        }
      }
      const n = (2 * k + 1) * (2 * k + 1);
      // 柔化强度单独用一根滑杆控制（1~100 → 2%~100% 的邻域均值混合比例）
      const amount = clamp(num('fm-blur-num') / 100, 0.02, 1);
      const fade = 0.12;
      for (let y = y0; y < y1; y++) {
        const dy = y + 0.5 - cy;
        const py = y - y0 + halo;
        const ya = (py - k) * iw;
        const yb = (py + k + 1) * iw;
        for (let x = x0; x < x1; x++) {
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2 || !allowed(x, y)) continue;
          const f = 1 - d2 / r2;
          // 中心到 f≈0.45 都是满强度，只在笔刷最外圈羽化，效果才不会局限在圆心一小块
          const a = Math.min(1, f * 2.2) * amount;
          if (a <= 0) continue;
          const px = x - x0 + halo;
          const xa = px - k;
          const xb = px + k + 1;
          const sumR = ir[yb + xb] - ir[ya + xb] - ir[yb + xa] + ir[ya + xa];
          const sumG = ig[yb + xb] - ig[ya + xb] - ig[yb + xa] + ig[ya + xa];
          const avgR = sumR / n + (NEUTRAL - sumR / n) * fade;
          const avgG = sumG / n + (NEUTRAL - sumG / n) * fade;
          const p = (y * W + x) * 2;
          write(x, y, Math.round(data[p] + (avgR - data[p]) * a), Math.round(data[p + 1] + (avgG - data[p + 1]) * a));
        }
      }
    } else {
      for (let y = y0; y < y1; y++) {
        const dy = y + 0.5 - cy;
        for (let x = x0; x < x1; x++) {
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2 || !allowed(x, y)) continue;
          const f = 1 - d2 / r2;
          // 擦除和柔化一样用宽羽化，整块笔刷范围内都在往中性色拉，
          // 否则只有圆心一小块有变化，看起来像没生效。
          const a = (mode === 'erase' ? Math.min(1, f * 2.2) : f * f) * strength;
          if (a <= 0) continue;
          const p = (y * W + x) * 2;
          write(x, y, Math.round(data[p] + (tr - data[p]) * a), Math.round(data[p + 1] + (tg - data[p + 1]) * a));
        }
      }
    }
    if (changed) {
      markDirty(x0, y0, x1, y1);
      opChanged = true;
    }
  }

  function applyAt(cx, cy, radius, strength, tr, tg, mode) {
    if (checked('fm-draw-tiles')) {
      cx = wrap(cx, W);
      cy = wrap(cy, H);
    }
    if (!checked('fm-seamless')) {
      stamp(cx, cy, radius, strength, tr, tg, mode);
      return;
    }
    // 主笔刷 + 最多 8 个镜像中心，等价于原版的 3×3 九宫格
    for (const ox of [-W, 0, W]) {
      for (const oy of [-H, 0, H]) {
        const mx = cx + ox;
        const my = cy + oy;
        if (mx + radius <= 0 || mx - radius >= W || my + radius <= 0 || my - radius >= H) continue;
        stamp(mx, my, radius, strength, tr, tg, mode);
      }
    }
  }

  function brushVector(angle) {
    const snap = num('fm-snap');
    if (snap) angle = Math.round(angle / snap) * snap;
    const radians = angle * Math.PI / 180;
    const magnitude = clamp(num('fm-magnitude'), 0, 100) / 100;
    return [encodeFlow(Math.cos(radians) * magnitude), encodeFlow(Math.sin(radians) * magnitude)];
  }

  function paintTo(tx, ty, mode) {
    if (!lastPoint) {
      lastPoint = { x: tx, y: ty };
      return;
    }
    const dx = tx - lastPoint.x;
    const dy = ty - lastPoint.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05) return;
    const radius = num('fm-radius-num');
    const step = Math.max(1, radius * 0.35);
    const n = clamp(Math.ceil(dist / step), 1, 64);
    const sens = num('fm-pressure-num') / 100;
    const speed = Math.min(1, dist / n / (radius * 1.5));
    const minF = (1 - sens) * 0.8;
    const pressure = minF + (1 - minF) * speed;
    // 擦除是覆盖式清除，不吃「流动强度」（默认 5% 只会抹掉几个百分点，看起来像没生效）
    const strength =
      mode === 'erase' ? 0.8 : clamp(num('fm-strength-num') / 100, 0.01, 1) * (0.35 + 0.65 * pressure);
    const ux = dx / dist;
    const uy = dy / dist;
    const angle = $('fm-direction').value === 'fixed' ? num('fm-angle') : Math.atan2(uy, ux) * 180 / Math.PI;
    const [tr, tg] = mode === 'draw' ? brushVector(angle) : [NEUTRAL, NEUTRAL];
    for (let i = 1; i <= n; i++) {
      applyAt(lastPoint.x + (dx * i) / n, lastPoint.y + (dy * i) / n, radius, strength, tr, tg, mode);
    }
    lastPoint = { x: tx, y: ty };
    cursor.dir = { x: ux, y: uy };
    requestDraw();
  }

  // ===== 主画布绘制 =====
  function fitView() {
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw < 2 || ch < 2) return;
    const tiles = checked('fm-draw-tiles') ? 3 : 1;
    view.scale = Math.min(cw / W, ch / H) * 0.94 / tiles;
    view.ox = (cw - W * view.scale) / 2;
    view.oy = (ch - H * view.scale) / 2;
    fitted = true;
    lastStageW = cw;
    lastStageH = ch;
    // 自动适配发生在鼠标移动之后时，把状态行里的百分比/坐标一并刷新
    if (cursor.inside) updateInfo(cursor.x, cursor.y);
    else infoEl.textContent = `画布：${W} × ${H} | 视图：${Math.round(view.scale * 100)}% | 坐标：-`;
    requestDraw();
  }

  function toTex(sx, sy) {
    return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
  }

  function syncSelection() {
    for (const button of $('fm-selection-actions').querySelectorAll('button')) {
      button.disabled = button.dataset.action === 'paste' ? !clipboard : !selection;
    }
    requestDraw();
  }

  function updateSeams() {
    const el = $('fm-seam-info');
    el.hidden = !checked('fm-draw-tiles');
    if (el.hidden) return;
    const diff = (a, b) => Math.hypot(decodeFlow(data[a]) - decodeFlow(data[b]),
      decodeFlow(data[a + 1]) - decodeFlow(data[b + 1]));
    let xSum = 0, ySum = 0;
    for (let y = 0; y < H; y++) xSum += diff(y * W * 2, (y * W + W - 1) * 2);
    for (let x = 0; x < W; x++) ySum += diff(x * 2, ((H - 1) * W + x) * 2);
    el.textContent = `接缝向量差 · 左右 ${(xSum / H).toFixed(3)} · 上下 ${(ySum / W).toFixed(3)}`;
  }

  function drawSelection() {
    const draft = pointer?.mode === 'select' ? pointer : null;
    const region = draft || selection;
    if (!region) return;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.beginPath();
    if (region.points) {
      for (const [i, point] of region.points.entries()) {
        if (i) ctx.lineTo(point.x, point.y);
        else ctx.moveTo(point.x, point.y);
      }
      ctx.closePath();
    } else if (draft) {
      ctx.rect(draft.start.x, draft.start.y, draft.end.x - draft.start.x, draft.end.y - draft.start.y);
    } else ctx.rect(region.x, region.y, region.w, region.h);
    ctx.lineWidth = 1.5 / view.scale;
    ctx.setLineDash([5 / view.scale, 3 / view.scale]);
    ctx.strokeStyle = '#7ce0ff';
    ctx.fillStyle = 'rgba(124,224,255,0.1)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function finishSelection(draft) {
    const points = draft.points;
    const bounds = points || [draft.start, draft.end];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const p of bounds) {
      x0 = Math.min(x0, Math.floor(p.x)); y0 = Math.min(y0, Math.floor(p.y));
      x1 = Math.max(x1, Math.ceil(p.x)); y1 = Math.max(y1, Math.ceil(p.y));
    }
    const w = x1 - x0, h = y1 - y0;
    selection = null;
    if (w > 0 && h > 0 && (!points || points.length >= 3)) {
      let mask = null;
      if (points) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const m = c.getContext('2d', { willReadFrequently: true });
        m.beginPath();
        for (const [i, p] of points.entries()) {
          if (i) m.lineTo(p.x - x0, p.y - y0);
          else m.moveTo(p.x - x0, p.y - y0);
        }
        m.fill('evenodd');
        const rgba = m.getImageData(0, 0, w, h).data;
        mask = new Uint8Array(w * h);
        for (let i = 0; i < mask.length; i++) mask[i] = Number(rgba[i * 4 + 3] >= 128);
      }
      selection = { x: x0, y: y0, w, h, mask, points };
    }
    syncSelection();
  }

  function copyRegion({ x, y, w, h, mask }) {
    const pixels = new Uint8Array(w * h * 2);
    for (let row = 0; row < h; row++) {
      const p = ((y + row) * W + x) * 2;
      pixels.set(data.subarray(p, p + w * 2), row * w * 2);
    }
    return { w, h, mask, pixels };
  }

  function editRegion(action, region) {
    finishPointer();
    const { x, y, w, h, mask } = region;
    beginOp();
    markTiles(x, y, x + w, y + h, opBefore);
    const radius = clamp(Math.round(num('fm-feather-num')), 1, 100);
    if (action === 'blur') {
      featherFlow(data, W, H, radius, region, checked('fm-seamless'));
    } else {
      const mirrorX = action === 'mirror-x', mirrorY = action === 'mirror-y';
      const copy = mirrorX || mirrorY ? copyRegion(region) : clipboard;
      const [r, g] = action === 'fill' ? brushVector(num('fm-angle')) : [NEUTRAL, NEUTRAL];
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const inside = !mask || mask[row * w + col];
          if (!inside && !mirrorX && !mirrorY) continue;
          const p = ((y + row) * W + x + col) * 2;
          if (action === 'invert') {
            data[p] = flipFlow(data[p]);
            data[p + 1] = flipFlow(data[p + 1]);
          } else if (mirrorX || mirrorY || action === 'paste') {
            const src = (mirrorY ? h - 1 - row : row) * copy.w + (mirrorX ? w - 1 - col : col);
            if (copy.mask && !copy.mask[src]) {
              if (inside && (mirrorX || mirrorY)) data[p] = data[p + 1] = NEUTRAL;
              continue;
            }
            data[p] = mirrorX ? flipFlow(copy.pixels[src * 2]) : copy.pixels[src * 2];
            data[p + 1] = mirrorY ? flipFlow(copy.pixels[src * 2 + 1]) : copy.pixels[src * 2 + 1];
          } else {
            data[p] = r;
            data[p + 1] = g;
          }
        }
      }
    }
    markDirty(x, y, x + w, y + h);
    opChanged = true;
    endOp();
    requestDraw();
  }

  function selectionAction(action) {
    if (action === 'clear') {
      selection = null;
      syncSelection();
    } else if (action === 'copy' && selection) {
      clipboard = copyRegion(selection);
      syncSelection();
      setStatus(`已复制 ${clipboard.w} × ${clipboard.h} 的流向选区`);
    } else if (action === 'paste' && clipboard) {
      const { x, y } = selection || { x: 0, y: 0 };
      editRegion(action, { x, y, w: Math.min(W - x, clipboard.w), h: Math.min(H - y, clipboard.h) });
      setStatus('已粘贴流向数据，可撤销');
    } else if (selection && ['fill', 'erase', 'blur', 'invert', 'mirror-x', 'mirror-y'].includes(action)) {
      editRegion(action, selection);
      if (selection.points && action.startsWith('mirror-')) {
        const { x, y, w, h, points } = selection;
        const flipped = points.map((point) => action === 'mirror-x'
          ? { x: 2 * x + w - point.x, y: point.y }
          : { x: point.x, y: 2 * y + h - point.y });
        finishSelection({ points: flipped });
      }
      setStatus('已处理选区，可撤销');
    }
  }

  function drawGrid() {
    const step = 64;
    ctx.save();
    ctx.strokeStyle = 'rgba(160,170,185,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += step) {
      const sx = view.ox + x * view.scale;
      ctx.moveTo(sx, view.oy);
      ctx.lineTo(sx, view.oy + H * view.scale);
    }
    for (let y = 0; y <= H; y += step) {
      const sy = view.oy + y * view.scale;
      ctx.moveTo(view.ox, sy);
      ctx.lineTo(view.ox + W * view.scale, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawArrows() {
    const step = Math.max(16, Math.round(36 / view.scale / 8) * 8);
    const len = step * 0.42;
    ctx.save();
    ctx.strokeStyle = arrowColor;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let y = step / 2; y < H; y += step) {
      for (let x = step / 2; x < W; x += step) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const p = (iy * W + ix) * 2;
        const vx = decodeFlow(data[p]);
        const vy = decodeFlow(data[p + 1]);
        const m = Math.hypot(vx, vy);
        if (m < 0.08) continue;
        const ex = (vx / m) * len;
        const ey = (vy / m) * len;
        const sx = view.ox + (x - ex / 2) * view.scale;
        const sy = view.oy + (y - ey / 2) * view.scale;
        ctx.moveTo(sx, sy);
        const tx = sx + ex * view.scale;
        const ty = sy + ey * view.scale;
        const head = Math.min(5, len * view.scale * 0.35);
        const ux = vx / m, uy = vy / m;
        ctx.lineTo(tx, ty);
        ctx.moveTo(tx - (ux + uy * 0.6) * head, ty - (uy - ux * 0.6) * head);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - (ux - uy * 0.6) * head, ty - (uy + ux * 0.6) * head);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawStage() {
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw < 2 || ch < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(pw / cw, 0, 0, ph / ch, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.clip();

    const mode = $('fm-view-mode').value;
    const dw = W * view.scale;
    const dh = H * view.scale;
    const radius = checked('fm-draw-tiles') ? 1 : 0;
    for (let ty = -radius; ty <= radius; ty++) {
      for (let tx = -radius; tx <= radius; tx++) {
        const x = view.ox + tx * dw, y = view.oy + ty * dh;
        if (mode === 'base' && baseCanvas) {
          ctx.drawImage(baseCanvas, x, y, dw, dh);
          ctx.globalAlpha = clamp(num('fm-opacity-num') / 100, 0, 1);
        }
        ctx.imageSmoothingEnabled = view.scale < 1;
        ctx.drawImage(disp, x, y, dw, dh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255, 214, 38, 0.65)';
        ctx.lineWidth = tx || ty ? 1 : 2;
        ctx.strokeRect(x, y, dw, dh);
      }
    }
    if (checked('fm-grid') && view.scale > 0.15) drawGrid();
    if (mode === 'arrows') drawArrows();
    drawSelection();

    if (cursor.inside && !pointer && !['sample', 'select'].includes(tool)) {
      const r = Math.max(3, num('fm-radius-num') * view.scale);
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(76, 194, 224, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(123, 214, 238, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
    drawScheduled = false;
  }

  // ===== WebGL 流动预览 =====
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader 编译失败');
    }
    return s;
  }

  function makeTexture(r, g, b, a) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function initGL() {
    try {
      gl = preview.getContext('webgl', { alpha: false, antialias: false }) || preview.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL 不可用');
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'shader 链接失败');
      }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uFlow', 'uBase', 'uTime', 'uSpeed', 'uDist', 'uScale', 'uDirectX', 'uMode', 'uRepeat', 'uBorder', 'uHasBase', 'uTiles', 'uUvShift', 'uUvWrap']) {
        uni[n] = gl.getUniformLocation(prog, n);
      }
      flowTex = makeTexture(128, 128, 0, 255);
      baseTex = makeTexture(40, 120, 150, 255);
      flowTexDirty = true;
      glOK = true;
      if (basePot) uploadTex(baseTex, basePot);
      preview.hidden = false;
      if (fallback) fallback.hidden = true;
      $('fm-fps').textContent = 'WebGL';
    } catch (ex) {
      glOK = false;
      $('fm-fps').textContent = '2D 降级';
      setStatus('实时预览不可用：' + (ex?.message ?? ex) + '（画布仍可正常绘制与导出）');
    }
  }

  function uploadTex(tex, source) {
    if (!glOK || !source) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  function pot(n) {
    let p = 1;
    while (p < n && p < 2048) p *= 2;
    return p;
  }

  function makeBasePot(src) {
    const c = document.createElement('canvas');
    c.width = pot(src.width);
    c.height = pot(src.height);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function setBase(src, custom) {
    baseCustom = custom;
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = src.width;
    baseCanvas.height = src.height;
    baseCanvas.getContext('2d').drawImage(src, 0, 0);
    basePot = makeBasePot(baseCanvas);
    if (glOK) uploadTex(baseTex, basePot);
    requestPreview();
    requestDraw();
  }

  function renderPreview() {
    const cw = previewWrap.clientWidth;
    const ch = previewWrap.clientHeight;
    if (cw < 2 || ch < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (glOK) {
      if (preview.width !== pw || preview.height !== ph) {
        preview.width = pw;
        preview.height = ph;
      }
      if (flowTexDirty) {
        uploadTex(flowTex, disp);
        flowTexDirty = false;
      }
      gl.viewport(0, 0, preview.width, preview.height);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, flowTex);
      gl.uniform1i(uni.uFlow, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, baseTex);
      gl.uniform1i(uni.uBase, 1);
      const tiles = clamp(Math.round(num('fm-tiles')), 1, 4);
      const border = checked('fm-tile');
      const repeat = border || tiles > 1;
      gl.activeTexture(gl.TEXTURE0);
      const flowWrap = repeat || checked('fm-seamless') ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, flowWrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, flowWrap);
      gl.activeTexture(gl.TEXTURE1);
      gl.uniform1f(uni.uTime, animTime);
      gl.uniform1f(uni.uSpeed, clamp(num('fm-speed-num') / 100, 0.01, 2));
      gl.uniform1f(uni.uDist, clamp(num('fm-dist-num') / 100, 0.01, 1));
      gl.uniform1f(uni.uScale, clamp(num('fm-scale-num') / 100, 1, 2));
      gl.uniform1f(uni.uDirectX, checked('fm-directx') ? 1 : 0);
      gl.uniform1f(uni.uMode, { flow: 0, rg: 1, base: 2 }[$('fm-preview-mode').value] ?? 0);
      gl.uniform1f(uni.uRepeat, repeat ? 1 : 0);
      gl.uniform1f(uni.uBorder, border ? 1 : 0);
      gl.uniform1f(uni.uHasBase, basePot ? 1 : 0);
      gl.uniform1f(uni.uTiles, repeat ? tiles : 1);
      // UV 动画：速度 0 关闭；1 单位 = 每秒滚过一整个贴图；方向向量默认取负，按钮可翻回正向
      const uvSpeed = clamp(num('fm-uv-speed-num') / 100, 0, 2);
      const uvDir = { u: [-1, 0], v: [0, -1], d: [-0.7071, -0.7071] }[$('fm-uv-dir').value] || [0, 0];
      const uvSign = $('fm-uv-reverse').classList.contains('on') ? -1 : 1;
      const uvOn = uvSpeed > 0 && (uvDir[0] !== 0 || uvDir[1] !== 0);
      const uvShift = uvOn
        ? [
            ((uvDir[0] * uvSign * uvSpeed * animTime) % 1 + 1) % 1,
            ((uvDir[1] * uvSign * uvSpeed * animTime) % 1 + 1) % 1,
          ]
        : [0, 0];
      gl.uniform2f(uni.uUvShift, uvShift[0], uvShift[1]);
      gl.uniform1f(uni.uUvWrap, uvOn ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    // 没有 WebGL 时退回 2D 静态预览，绘制与导出不受影响
    if (!fallback) {
      fallback = document.createElement('canvas');
      previewWrap.append(fallback);
    }
    preview.hidden = true;
    fallback.hidden = false;
    if (fallback.width !== pw) fallback.width = pw;
    if (fallback.height !== ph) fallback.height = ph;
    const c2 = fallback.getContext('2d');
    c2.setTransform(pw / cw, 0, 0, ph / ch, 0, 0);
    c2.fillStyle = '#101114';
    c2.fillRect(0, 0, cw, ch);
    const source = $('fm-preview-mode').value !== 'rg' && baseCanvas ? baseCanvas : disp;
    const s = Math.min(cw / source.width, ch / source.height);
    const w = source.width * s, h = source.height * s;
    c2.drawImage(source, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  // ===== 每帧循环 =====
  function frame(ts) {
    frameRequest = 0;
    if (page.classList.contains('hidden') || document.hidden) {
      lastTs = fpsFrames = fpsTs = 0;
      return;
    }
    const mode = $('fm-preview-mode').value;
    const uvScrolling = num('fm-uv-speed-num') > 0 && $('fm-uv-dir').value !== 'off';
    const animate = playing && glOK && (mode === 'flow' || (mode === 'base' && uvScrolling));
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    // 页签隐藏时量为 0，显示后布局还会再变几帧：每帧盯着尺寸，稳定了再自动适配
    if (!userAdjustedView) {
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (cw > 2 && ch > 2 && (!fitted || Math.abs(cw - lastStageW) > 1 || Math.abs(ch - lastStageH) > 1)) {
        fitView();
      }
    }
    if (animate) animTime += dt;
    if (dirty) flushDirty();
    if (drawScheduled) drawStage();
    if (animate || previewDirty) renderPreview();
    previewDirty = false;
    if (!animate) {
      if (glOK) $('fm-fps').textContent = playing ? 'WebGL · 静态' : 'WebGL · 已暂停';
      lastTs = fpsFrames = fpsTs = 0;
      return;
    }
    fpsFrames++;
    if (!fpsTs) fpsTs = ts;
    if (ts - fpsTs > 1000) {
      $('fm-fps').textContent = `WebGL · ${Math.round((fpsFrames * 1000) / (ts - fpsTs))} fps`;
      fpsFrames = 0;
      fpsTs = ts;
    }
    scheduleFrame();
  }

  // ===== 交互：绘制 / 平移 / 缩放 / 调笔刷 =====
  function stagePos(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function updateInfo(sx, sy) {
    const p = toTex(sx, sy);
    const tiled = checked('fm-draw-tiles');
    const inRange = tiled ? p.x >= -W && p.y >= -H && p.x < 2 * W && p.y < 2 * H
      : p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
    infoEl.textContent =
      `画布：${W} × ${H} | 视图：${Math.round(view.scale * 100)}% | 坐标：` +
      (inRange ? `${Math.floor(wrap(p.x, W))}, ${Math.floor(wrap(p.y, H))}` : '画布外');
  }

  stage.addEventListener('pointerdown', (e) => {
    if (pointer || fileBusy || ![0, 1, 2].includes(e.button)) return;
    const s = stagePos(e);
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (_) {
      // 合成事件 / 某些 WebView 下 pointerId 不是活跃指针，捕获失败不影响绘制
    }
    if (e.button === 1 || spaceDown) {
      userAdjustedView = true;
      pointer = { id: e.pointerId, mode: 'pan', sx: s.x, sy: s.y, ox: view.ox, oy: view.oy };
      stage.classList.add('panning');
      e.preventDefault();
      return;
    }
    const mode = e.button === 2 ? 'erase' : shiftDown ? 'blur' : tool;
    const p = toTex(s.x, s.y);
    if (mode === 'sample') {
      const tiled = checked('fm-draw-tiles');
      const offset = tiled ? 1 : 0;
      if (p.x < -W * offset || p.x >= W * (1 + offset) ||
          p.y < -H * offset || p.y >= H * (1 + offset)) return;
      const index = (Math.floor(wrap(p.y, H)) * W + Math.floor(wrap(p.x, W))) * 2;
      const x = decodeFlow(data[index]), y = decodeFlow(data[index + 1]);
      const angle = wrap(Math.round(Math.atan2(y, x) * 180 / Math.PI), 360);
      const magnitude = Math.round(Math.min(1, Math.hypot(x, y)) * 100);
      $('fm-angle').value = String(angle);
      $('fm-magnitude').value = String(magnitude);
      $('fm-direction').value = 'fixed';
      $('fm-snap').value = '0';
      selectTool('draw');
      setStatus(`已吸取流向：${angle}°，流速 ${magnitude}%`);
      return;
    }
    if (mode === 'select') {
      const start = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
      const points = $('fm-selection-shape').value === 'lasso' ? [start] : null;
      pointer = { id: e.pointerId, mode, start, end: start, points };
      requestDraw();
      e.preventDefault();
      return;
    }
    beginOp();
    lastPoint = null;
    pointer = { id: e.pointerId, mode };
    if (mode !== 'draw' || $('fm-direction').value === 'fixed') {
      const [r, g] = mode === 'draw' ? brushVector(num('fm-angle')) : [NEUTRAL, NEUTRAL];
      const strength = mode === 'erase' ? 0.8 : clamp(num('fm-strength-num') / 100, 0.01, 1);
      applyAt(p.x, p.y, num('fm-radius-num'), strength, r, g, mode);
      requestDraw();
    }
    paintTo(p.x, p.y, mode);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    const s = stagePos(e);
    cursor.x = s.x;
    cursor.y = s.y;
    cursor.inside = true;
    updateInfo(s.x, s.y);
    if (!pointer || pointer.id !== e.pointerId) {
      requestDraw();
      return;
    }
    if (pointer.mode === 'pan') {
      view.ox = pointer.ox + (s.x - pointer.sx);
      view.oy = pointer.oy + (s.y - pointer.sy);
      requestDraw();
      return;
    }
    const p = toTex(s.x, s.y);
    if (pointer.mode === 'select') {
      pointer.end = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
      pointer.points?.push(pointer.end);
      requestDraw();
      return;
    }
    paintTo(p.x, p.y, pointer.mode);
  });

  function finishPointer(e) {
    if (!pointer || (e && e.pointerId !== pointer.id)) return;
    if (pointer.mode === 'select' && e?.type === 'pointerup') {
      const { x, y } = stagePos(e);
      const p = toTex(x, y);
      pointer.end = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
      pointer.points?.push(pointer.end);
      finishSelection(pointer);
    }
    if (['draw', 'erase', 'blur'].includes(pointer.mode)) {
      endOp();
      lastPoint = null;
    }
    pointer = null;
    stage.classList.remove('panning');
    requestDraw();
  }
  stage.addEventListener('pointerup', finishPointer);
  stage.addEventListener('pointercancel', finishPointer);
  stage.addEventListener('lostpointercapture', finishPointer);
  stage.addEventListener('pointerleave', () => {
    if (pointer) return;
    cursor.inside = false;
    requestDraw();
  });

  stage.addEventListener(
    'wheel',
    (e) => {
      // Ctrl / Cmd + 滚轮交给下面整页监听去调笔刷，这里不要顺便缩放视图
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const s = stagePos(e);
      const t = toTex(s.x, s.y);
      userAdjustedView = true;
      const old = view.scale;
      const next = clamp(old * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.05, 20);
      view.scale = next;
      view.ox = s.x - t.x * next;
      view.oy = s.y - t.y * next;
      updateInfo(s.x, s.y);
      requestDraw();
    },
    { passive: false }
  );

  // ===== Ctrl + 滚轮：调节笔刷大小 =====
  // 绑整页而不是只绑画布：画布、参数栏、预览区都能调。
  // preventDefault 顺带挡掉 WebView 的 Ctrl+滚轮页面缩放。
  let brushWheelAcc = 0;
  function setBrushSize(v, quiet) {
    const r = clamp(Math.round(v), 5, 200);
    $('fm-radius').value = String(r);
    $('fm-radius-num').value = String(r);
    requestDraw();
    if (!quiet) setStatus(`笔刷大小：${r} px`);
    return r;
  }
  page.addEventListener(
    'wheel',
    (e) => {
      if (page.classList.contains('hidden')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
      brushWheelAcc += e.deltaY * unit;
      // 触控板每次 delta 很小，攒够一档再动，免得逐像素刷新状态行
      if (Math.abs(brushWheelAcc) < 12) return;
      const cur = num('fm-radius-num');
      const factor = Math.pow(1.12, -brushWheelAcc / 100);
      brushWheelAcc = 0;
      const next = setBrushSize(cur * factor, true);
      if (next !== cur) setStatus(`笔刷大小：${next} px（Ctrl + 滚轮）`);
    },
    { passive: false }
  );

  // ===== 控件 =====
  function link(rangeId, numId, onChange) {
    const r = $(rangeId);
    const n = $(numId);
    const apply = () => onChange && onChange();
    r.addEventListener('input', () => {
      n.value = r.value;
      apply();
    });
    n.addEventListener('input', () => {
      const v = clamp(Number(n.value) || Number(r.min), Number(r.min), Number(r.max));
      r.value = String(v);
      apply();
    });
    n.addEventListener('change', () => {
      n.value = String(clamp(Number(n.value) || Number(r.min), Number(r.min), Number(r.max)));
      apply();
    });
  }
  link('fm-radius', 'fm-radius-num', requestDraw);
  link('fm-strength', 'fm-strength-num');
  link('fm-pressure', 'fm-pressure-num');
  link('fm-blur', 'fm-blur-num');
  link('fm-feather', 'fm-feather-num');
  link('fm-opacity', 'fm-opacity-num', requestDraw);
  link('fm-speed', 'fm-speed-num', requestPreview);
  link('fm-dist', 'fm-dist-num', requestPreview);
  link('fm-scale', 'fm-scale-num', requestPreview);
  link('fm-uv-speed', 'fm-uv-speed-num', requestPreview);

  // ===== 恢复默认参数 =====
  // 滑杆和数字框是成对的，程序改 value 不会触发 link() 的 input 事件，所以两个 id 都要写。
  // 画布分辨率会清空绘制内容、文件名属于用户输入，两者刻意不参与恢复，避免误触丢失工作成果。
  const DRAW_DEFAULTS = [
    ['fm-radius', 200], ['fm-radius-num', 200],
    ['fm-strength', 5], ['fm-strength-num', 5],
    ['fm-pressure', 70], ['fm-pressure-num', 70],
    ['fm-blur', 20], ['fm-blur-num', 20],
    ['fm-feather', 8], ['fm-feather-num', 8],
    ['fm-view-mode', 'flow'],
    ['fm-opacity', 65], ['fm-opacity-num', 65],
    ['fm-seamless', true], ['fm-grid', false],
    ['fm-draw-tiles', false], ['fm-selection-shape', 'rect'],
    ['fm-direction', 'stroke'], ['fm-angle', 0], ['fm-snap', '0'], ['fm-magnitude', 100],
    ['fm-fmt', 'png'], ['fm-export-size', '0'],
    ['fm-inv-r', false], ['fm-inv-g', false], ['fm-export-preset', 'custom'],
  ];
  const PREVIEW_DEFAULTS = [
    ['fm-speed', 50], ['fm-speed-num', 50],
    ['fm-dist', 30], ['fm-dist-num', 30],
    ['fm-scale', 200], ['fm-scale-num', 200],
    ['fm-uv-dir', 'u'], ['fm-uv-speed', 0], ['fm-uv-speed-num', 0], ['fm-uv-reverse', false],
    ['fm-tiles', '1'], ['fm-preview-mode', 'flow'],
    ['fm-directx', false], ['fm-tile', false],
  ];

  function applySettings(defs, settings = {}) {
    for (const [id, fallback] of defs) {
      const el = $(id);
      let v = settings[id];
      if (typeof fallback === 'boolean') {
        if (typeof v !== 'boolean') v = fallback;
      } else if (el.tagName === 'SELECT') {
        if (![...el.options].some((option) => option.value === v)) v = fallback;
      } else {
        if (typeof v !== typeof fallback) v = fallback;
        if (el.type === 'range' || el.type === 'number') {
          v = Number.isFinite(v) ? clamp(v, Number(el.min), Number(el.max)) : fallback;
        }
      }
      if (el.type === 'checkbox') el.checked = v;
      else if (el.tagName === 'BUTTON') el.classList.toggle('on', !!v);
      else el.value = String(v);
    }
    updateSeams();
    syncExportPreset();
    requestPreview();
    requestDraw();
  }

  function restoreParams(defs, label, btn, note) {
    applySettings(defs);
    if (defs === DRAW_DEFAULTS && !userAdjustedView) fitView();
    setStatus(`${label}已恢复默认（${note}）`);
    btn.textContent = '已恢复默认';
    clearTimeout(btn._resetTimer);
    btn._resetTimer = setTimeout(() => {
      btn.textContent = '恢复默认';
    }, 1400);
  }

  $('fm-reset-draw').addEventListener('click', () =>
    restoreParams(DRAW_DEFAULTS, '绘制参数', $('fm-reset-draw'), '画布分辨率与文件名保持不变')
  );
  $('fm-reset-preview').addEventListener('click', () =>
    restoreParams(PREVIEW_DEFAULTS, '预览参数', $('fm-reset-preview'), '动画播放状态保持不变')
  );

  // 按钮和快捷键共用同一处选中逻辑，免得两边的 .on 状态走偏
  function selectTool(name) {
    tool = name;
    for (const b of $('fm-tool-row').querySelectorAll('.btn'))
      b.classList.toggle('on', b.dataset.tool === name);
  }
  $('fm-feather-apply').addEventListener('click', () => {
    if (fileBusy) return;
    const r = clamp(Math.round(num('fm-feather-num')), 1, 100);
    const t0 = performance.now();
    editRegion('blur', { x: 0, y: 0, w: W, h: H });
    setStatus(`整幅羽化 ${r}px 完成（${Math.round(performance.now() - t0)} ms，可撤销）`);
  });
  for (const button of $('fm-tool-row').querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }
  $('fm-selection-actions').addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (button && !fileBusy) selectionAction(button.dataset.action);
  });
  $('fm-undo').addEventListener('click', undo);
  $('fm-redo').addEventListener('click', redo);
  $('fm-clear').addEventListener('click', () => {
    if (fileBusy) return;
    finishPointer();
    beginOp();
    markTiles(0, 0, W, H, opBefore);
    data.fill(NEUTRAL);
    opChanged = true;
    rebuildDisplay();
    endOp();
    setStatus('画布已清空（可撤销）');
  });
  $('fm-fit').addEventListener('click', () => {
    userAdjustedView = false;
    fitView();
  });
  $('fm-actual').addEventListener('click', () => {
    userAdjustedView = true;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    view.scale = 1;
    view.ox = (cw - W) / 2;
    view.oy = (ch - H) / 2;
    requestDraw();
  });
  $('fm-reset').addEventListener('click', () => {
    userAdjustedView = false;
    fitView();
  });
  $('fm-play').addEventListener('click', () => {
    playing = !playing;
    $('fm-play').textContent = playing ? '暂停动画' : '播放动画';
    $('fm-play').classList.toggle('on', playing);
    if (glOK && !playing) $('fm-fps').textContent = 'WebGL · 已暂停';
    requestPreview();
  });
  $('fm-reset-time').addEventListener('click', () => {
    animTime = 0;
    requestPreview();
  });
  $('fm-uv-reverse').addEventListener('click', () => {
    $('fm-uv-reverse').classList.toggle('on');
    requestPreview();
  });
  $('fm-size').addEventListener('change', () => {
    const size = Number($('fm-size').value);
    if (size === W) return;
    if (!FLOW_SIZES.includes(size) || fileBusy ||
      ((hasContent || undoStack.length || redoStack.length) &&
      !confirm('切换分辨率会重采样当前流向并清除撤销与重做历史，继续？'))) {
      $('fm-size').value = String(W);
      return;
    }
    finishPointer();
    initData(size, hasContent ? resizeFlow(data, W, H, size, size, checked('fm-seamless')) : undefined);
    setStatus(`画布已切换为 ${size} × ${size}`);
  });
  for (const id of ['fm-view-mode', 'fm-grid', 'fm-seamless']) {
    $(id).addEventListener('change', requestDraw);
  }
  $('fm-draw-tiles').addEventListener('change', () => {
    updateSeams();
    userAdjustedView = false;
    fitView();
  });
  for (const id of ['fm-preview-mode', 'fm-directx', 'fm-tile', 'fm-tiles', 'fm-uv-dir', 'fm-seamless']) {
    $(id).addEventListener('change', requestPreview);
  }

  // ===== 文件：导入流向图 / 底图、导出 PNG / TGA =====
  async function importFlowmap(entry) {
    const bytes = await readEntryBytes(entry);
    const src = await decodeToCanvas(entry.name, bytes);
    const im = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    const rg = new Uint8Array(src.width * src.height * 2);
    for (let i = 0; i < rg.length / 2; i++) {
      rg[i * 2] = im[i * 4 + 3] ? im[i * 4] : NEUTRAL;
      rg[i * 2 + 1] = im[i * 4 + 3] ? im[i * 4 + 1] : NEUTRAL;
    }
    finishPointer();
    beginOp();
    markTiles(0, 0, W, H, opBefore);
    data = resizeFlow(rg, src.width, src.height, W, H, checked('fm-seamless'));
    opChanged = true;
    rebuildDisplay();
    endOp();
    setStatus(`已导入流向图：${entry.name}（缩放到 ${W} × ${H}，B 通道忽略）`);
  }

  async function importBase(entry) {
    const bytes = await readEntryBytes(entry);
    const img = await decodeToCanvas(entry.name, bytes);
    setBase(img, true);
    setStatus(`已载入底图：${entry.name}（${img.width} × ${img.height}）`);
  }

  async function loadEntry(entry) {
    if (/\.pudiflow$/i.test(entry.name)) return openProject(entry);
    if (fileBusy) return;
    if (!isSupportedName(entry.name, TEXTURE_EXTS)) {
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    setStatus('正在载入…');
    fileBusy = true;
    try {
      await importBase(entry);
    } catch (ex) {
      setStatus('载入失败：' + (ex?.message ?? ex));
    } finally {
      fileBusy = false;
    }
  }

  function syncExportPreset() {
    const preset = $('fm-export-preset').value;
    const custom = preset === 'custom';
    $('fm-inv-r').disabled = $('fm-inv-g').disabled = !custom;
    if (!custom) {
      $('fm-inv-r').checked = false;
      $('fm-inv-g').checked = preset === 'unity';
    }
    const note = $('fm-export-note');
    note.hidden = custom;
    note.textContent = preset === 'unity'
      ? '适用于 UV 的 +Y 向上的采样方式（导出时翻转 G）。Unity 导入时关闭 sRGB（Color Texture）。'
      : '适用于 UV 的 +Y 向下的采样方式（保留 G）。Unreal 导入时关闭 sRGB。';
  }

  async function saveOutput(filename, makeBytes) {
    if (fileBusy) return;
    finishPointer();
    fileBusy = true;
    try {
      const dir = await resolveSaveDir(null);
      if (isTauri && !dir) return;
      setStatus('正在导出…');
      const bytes = await makeBytes();
      const safeName = await uniqueFilename(dir, filename);
      const saved = await saveBlob(safeName, bytes, dir);
      if (saved) setStatus(`已保存：${saved}（${humanSize(bytes.length)}）`);
    } catch (ex) {
      setStatus('保存失败：' + (ex?.message ?? ex));
    } finally {
      fileBusy = false;
    }
  }

  function outputStem() {
    return ($('fm-name').value.trim() || 'flowmap').replace(/\.(png|tga|pudiflow)$/i, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'flowmap';
  }

  function exportCanvas(size, pixels, invertR, invertG) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const cc = c.getContext('2d');
    const im = cc.createImageData(size, size);
    const out = im.data;
    for (let i = 0, p = 0; i < out.length; i += 4, p += 2) {
      out[i] = invertR ? flipFlow(pixels[p]) : pixels[p];
      out[i + 1] = invertG ? flipFlow(pixels[p + 1]) : pixels[p + 1];
      out[i + 2] = 0;
      out[i + 3] = 255;
    }
    cc.putImageData(im, 0, 0);
    return c;
  }

  function exportFlowmap() {
    if (fileBusy) return;
    const ext = $('fm-fmt').value;
    const size = num('fm-export-size') || W;
    const width = W, height = H, pixels = data.slice();
    const invertR = checked('fm-inv-r'), invertG = checked('fm-inv-g');
    const tiled = checked('fm-seamless');
    return saveOutput(`${outputStem()}.${ext}`, () => {
      const resized = width === size && height === size ? pixels : resizeFlow(pixels, width, height, size, size, tiled);
      return encodeCanvas(exportCanvas(size, resized, invertR, invertG), ext);
    });
  }

  function saveProject() {
    if (fileBusy) return;
    const settings = {};
    for (const [id, fallback] of [...DRAW_DEFAULTS, ...PREVIEW_DEFAULTS]) {
      const el = $(id);
      settings[id] = el.type === 'checkbox' ? el.checked
        : el.tagName === 'BUTTON' ? el.classList.contains('on')
        : typeof fallback === 'number' ? Number(el.value) : el.value;
    }
    settings.tool = tool;
    const size = W, pixels = data.slice(), base = baseCustom ? baseCanvas : null;
    return saveOutput(`${outputStem()}.pudiflow`, async () => {
      const blob = base ? await canvasToBlob(base, 'image/png') : null;
      return new Uint8Array(await packFlowProject(size, pixels, settings, blob).arrayBuffer());
    });
  }

  async function openProject(entry) {
    if (fileBusy) return;
    finishPointer();
    fileBusy = true;
    try {
      const project = unpackFlowProject(await readEntryBytes(entry));
      const base = project.base.length ? await decodeToCanvas('base.png', project.base) : defaultBase;
      if ((hasContent || undoStack.length || redoStack.length) &&
          !confirm('打开工程会替换当前画布与撤销历史，继续？')) return;
      initData(project.size, project.data);
      $('fm-size').value = String(project.size);
      $('fm-name').value = entry.name.replace(/\.pudiflow$/i, '');
      const settings = project.settings || {};
      applySettings(DRAW_DEFAULTS, settings);
      applySettings(PREVIEW_DEFAULTS, settings);
      const validTool = [...$('fm-tool-row').querySelectorAll('[data-tool]')].some((b) => b.dataset.tool === settings.tool);
      selectTool(validTool ? settings.tool : 'draw');
      baseCustom = false;
      if (base) setBase(base, !!project.base.length);
      fitView();
      setStatus(`已打开工程：${entry.name}`);
    } catch (ex) {
      setStatus('打开工程失败：' + (ex?.message ?? ex));
    } finally {
      fileBusy = false;
    }
  }

  $('fm-import').addEventListener('click', async () => {
    if (fileBusy) return;
    const entries = await pickImages(false, TEXTURE_EXTS, { title: '导入流向图' });
    if (!entries.length) return;
    const entry = entries[0];
    if (!isSupportedName(entry.name, TEXTURE_EXTS)) {
      setStatus('不支持的格式：' + entry.name);
      return;
    }
    if (fileBusy) return;
    setStatus('正在载入…');
    fileBusy = true;
    try {
      await importFlowmap(entry);
    } catch (ex) {
      setStatus('导入失败：' + (ex?.message ?? ex));
    } finally {
      fileBusy = false;
    }
  });
  $('fm-base').addEventListener('click', async () => {
    const entries = await pickImages(false, TEXTURE_EXTS, { title: '导入底图' });
    if (entries.length) await loadEntry(entries[0]);
  });
  $('fm-export').addEventListener('click', exportFlowmap);
  $('fm-export-preset').addEventListener('change', syncExportPreset);
  $('fm-project-save').addEventListener('click', saveProject);
  $('fm-project-open').addEventListener('click', async () => {
    try {
      const [entry] = await pickImages(false, ['pudiflow'], { title: '打开 Flowmap 工程' });
      if (entry) await openProject(entry);
    } catch (ex) {
      setStatus('打开工程失败：' + (ex?.message ?? ex));
    }
  });

  // ===== 快捷键（只在当前页签生效，输入框里不抢按键） =====
  function typing(e) {
    const t = e.target;
    return t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  }
  document.addEventListener('keydown', (e) => {
    if (typing(e) || page.classList.contains('hidden') || fileBusy) return;
    const k = e.key.toLowerCase();
    // Ctrl+Shift+Z 已按要求移除：带 Shift 的 Z 不再吃掉，也不做重做
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' && !e.shiftKey) {
        e.preventDefault();
        redo();
      }
      return;
    }
    if (k === 'b') {
      selectTool('draw');
      setStatus('工具：绘制流向（B）');
    } else if (k === 'e') {
      selectTool('erase');
      setStatus('工具：擦除（E）');
    } else if (k === 'i') {
      selectTool('sample');
    } else if (k === 'm') {
      selectTool('select');
    } else if (k === 'escape' && selection) {
      selectionAction('clear');
    } else if (k === 'f') {
      userAdjustedView = false;
      fitView();
    } else if (e.code === 'Space') {
      spaceDown = true;
      e.preventDefault();
    }
    if (k === 'shift') shiftDown = true;
  });
  document.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'shift') shiftDown = false;
    if (e.code === 'Space') spaceDown = false;
  });
  addEventListener('blur', () => {
    spaceDown = shiftDown = false;
    finishPointer();
  });
  window.addEventListener('themechange', syncThemeColors);

  // ===== 启动 =====
  syncThemeColors();
  initData(1024);
  initGL();
  preview.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    glOK = false;
    $('fm-fps').textContent = '2D 静态预览';
    setStatus('WebGL 暂时不可用，已切换到静态预览');
    requestPreview();
  });
  preview.addEventListener('webglcontextrestored', () => {
    initGL();
    if (glOK) setStatus('WebGL 预览已恢复');
    requestPreview();
  });
  updateHistoryLabel();
  fitView();

  const ro = new ResizeObserver(() => {
    requestDraw();
    requestPreview();
  });
  ro.observe(stage);
  ro.observe(previewWrap);

  // 默认底图：原版启动时加载的同一张水面焦散贴图
  const water = new Image();
  water.onload = () => {
    defaultBase = water;
    if (!baseCustom) setBase(water, false);
  };
  water.onerror = () => setStatus('默认底图未找到，可自行导入底图');
  water.src = new URL('../assets/flowmap-water.png', import.meta.url).href;

  new MutationObserver(() => {
    lastTs = fpsFrames = fpsTs = 0;
    requestDraw();
    requestPreview();
  }).observe(page, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => {
    lastTs = fpsFrames = fpsTs = 0;
    requestPreview();
  });
  scheduleFrame();
  return { loadEntry };
}
