import { uvSeamFlags } from './model-topology.js';
// 3D 的 UV 工具层：UV 变换、贴图黑透、UV 展开图、FBX ASCII 导出。
//
// 和 model3d.js 分工：那边管「解析 + 画一帧」，这边管「用户改过的那一份 UV」和写文件。
// 全模块不碰 DOM 结构，只收 canvas / context，所以台架里能单独 import 验数。
//
// UV 坐标口径：内部统一原点左上（v 向下），和 canvas / glTF TEXCOORD 一致。
// 导出 FBX 时 v 翻回左下（1-v），因为 FBX 的 LayerElementUV 是左下原点。

export const DEFAULT_UV_STATE = Object.freeze({ rot: 0, flipU: false, flipV: false });

// 旋转 / 镜像：先镜像，再绕 UV 空间中心 (0.5, 0.5) 旋转 rot 度。
// 同一份变换同时用于预览采样和导出，所以「所见」就是「存出去那份」。
export function transformUv(uv, st) {
  const s = st || DEFAULT_UV_STATE;
  const rad = (Number(s.rot) || 0) * Math.PI / 180;
  const c = Math.cos(rad), sn = Math.sin(rad);
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    let u = uv[i], v = uv[i + 1];
    if (s.flipU) u = 1 - u;
    if (s.flipV) v = 1 - v;
    const du = u - 0.5, dv = v - 0.5;
    out[i] = 0.5 + du * c - dv * sn;
    out[i + 1] = 0.5 + du * sn + dv * c;
  }
  return out;
}

export function uvStateLabel(st) {
  const bits = [];
  if (st.flipU) bits.push('镜像 U');
  if (st.flipV) bits.push('镜像 V');
  if (st.rot) bits.push(`旋转 ${((st.rot % 360) + 360) % 360}°`);
  return bits.length ? bits.join(' · ') : '未修改';
}

// 导入的图先画进离屏 canvas，再按需要改 alpha。
// threshold 是近黑阈值（0 = 只有纯黑 (0,0,0) 全透），按 RGB 最大通道判，
// 比按亮度判更贴近「黑色区域」这四个字：暗红、暗蓝不会被误挖掉。
//
// additive = 按亮度做渐变的 add 语义（「半透明」按钮开着时走这一档）：
//   alpha = 原 alpha × max(R,G,B)/255 × op，黑色 alpha=0 完全透明、纯白 alpha=255
//   不透明、中间灰阶依次半透 —— 相当于 shader 里把这张图当加色遮罩，黑处不贡献、
//   白处全贡献。不是「整张图统一变半透」。
// op（= 1 - 滑条档位）再叠一层整体衰减：0 档就是纯粹的亮度渐变，往 1 滑整张
//   依次淡到全透。关掉按钮时不传 additive，贴图回到不透明原样。
// 每张贴图每次都从 bitmap 重画一遍，关掉开关时能立刻还原，不留上次的洞。
export function makeTexture(bitmap, {
  blackTransparent = true, threshold = 0, opacity = 1, additive = false,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  let transparent = 0, opaque = true;
  const op = Math.max(0, Math.min(1, Number(opacity)));
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const p = d.data;
  if (blackTransparent || additive || op < 1) {
    const t = Math.max(0, Math.min(255, Number(threshold) || 0));
    for (let i = 0; i < p.length; i += 4) {
      const luma = Math.max(p[i], p[i + 1], p[i + 2]);
      let a = p[i + 3];
      if (blackTransparent && luma <= t) a = 0;
      else if (additive) a = Math.round(a * (luma / 255) * op);
      else if (op < 1) a = Math.round(a * op);
      p[i + 3] = a;
      if (a === 0) transparent++;
      if (a !== 255) opaque = false;
    }
    ctx.putImageData(d, 0, 0);
  } else {
    for (let i = 3; i < p.length; i += 4) {
      if (p[i] !== 255) { opaque = false; break; }
    }
  }
  return { canvas, w: canvas.width, h: canvas.height, transparent, opaque,
    blackTransparent, threshold, additive, opacity: op };
}

// UV 展开图的配色：常态是白色 UV 线，选中的岛 / 框选结果用主题青。
export const UV_COLORS = Object.freeze({ line: '#ffffff', seam: '#58df87', selection: '#7ce0ff' });
export const UV_LAYOUT_PAD = 10;
// 面板初始视图缩小 10%，给 UV 外围留出框选空间。
export const UV_DEFAULT_ZOOM = 0.9;
export const UV_MIN_ZOOM = UV_DEFAULT_ZOOM * 0.1;

// 0~1 的 UV 空间 ↔ 画布像素。zoom=1 / center=(0.5,0.5) 时和最初那套固定映射完全一致；
// UV (0.5, 0.5) 是蓝色边框的中心，与平移后画布中心处的 UV 坐标可能不同。
export function uvLayoutView(w, h, view = {}) {
  const pad = UV_LAYOUT_PAD;
  const W = Math.max(1, w - pad * 2), H = Math.max(1, h - pad * 2);
  const zoom = Math.max(UV_MIN_ZOOM, Math.min(12, Number(view.zoom) || 1));
  const c = view.center || { u: 0.5, v: 0.5 };
  const cx = Number.isFinite(c.u) ? c.u : 0.5;
  const cy = Number.isFinite(c.v) ? c.v : 0.5;
  return {
    pad, W, H, zoom, cx, cy,
    x: (u) => pad + W * (0.5 + (u - cx) * zoom),
    y: (v) => pad + H * (0.5 + (v - cy) * zoom),
    u: (x) => cx + ((x - pad) / W - 0.5) / zoom,
    v: (y) => cy + ((y - pad) / H - 0.5) / zoom,
  };
}

const asSelection = (selection) => {
  if (selection == null || selection === false) return null;
  if (selection instanceof Set) return selection;
  if (Array.isArray(selection)) return new Set(selection);
  const n = Number(selection);
  return Number.isInteger(n) && n >= 0 ? new Set([n]) : null;
};

// 元素标记：'f:面号:0' / 'e:面号:边号' / 'v:面号:顶点号' / 'i:面号:0'（整块 UV 岛）。
// 点 / 线模式下选中的不再是整片三角面，而是它的某个角或某条边。
export const UV_ELEMENTS = Object.freeze({ vertex: 'v', edge: 'e', face: 'f', island: 'i' });
export function uvMarkKey(kind, tri, idx = 0) {
  const c = UV_ELEMENTS[kind] || String(kind).charAt(0);
  return `${c}:${tri}:${idx}`;
}
export function parseUvMark(key) {
  const p = String(key).split(':');
  if (p.length !== 3) return null;
  const kind = p[0] === 'v' ? 'vertex' : p[0] === 'e' ? 'edge'
    : p[0] === 'f' ? 'face' : p[0] === 'i' ? 'island' : null;
  const tri = Number(p[1]), idx = Number(p[2]);
  return kind && Number.isInteger(tri) && tri >= 0 && Number.isInteger(idx) && idx >= 0
    ? { kind, tri, idx } : null;
}

// UV 展开图：0~1 方框 + 1/4 网格 + 逐三角形的 UV 边（白色）。
// element = 'vertex' | 'edge' | 'face' | 'island'（默认面），marks 是 uvMarkKey() 的键集合；
// 旧的 selection（面号集合）仍兼容，等价于一组面标记。
//
// 线宽口径：UV 岛的线按「UV 空间固定宽度」画，而不是屏幕固定 1px。
// 以前固定 1px 时，UV 窗口缩小 / 滚轮缩小会让线挤在一起显得变粗，放大又显得变细；
// 现在线宽跟着 uvLayoutView 的 (画布有效宽 / 240) × zoom 同比缩放，视觉粗细恒定。
// 选中的线**只换颜色、不加宽**（曾按 2×lw 描，缩放时会被误认成另一套线宽）。
// 选中的面则整片填一层半透明青，再描同色亮边，和模型上 isPicked() 的观感一致。
// 0~1 方框边界（浅灰）、两级网格和框选虚线是参考线，仍保持固定 1px；
// 16×16 小网格比 4×4 大网格更淡，青色只留给选中态。
export function drawUvLayout(ctx, uv, w, h, {
  color = UV_COLORS.line, selectionColor = UV_COLORS.selection,
  selection = null, marks = null, element = 'face', view = null, box = null, seamFlags = null,
} = {}) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#151922';
  ctx.fillRect(0, 0, w, h);
  const m = uvLayoutView(w, h, view || {});
  const lw = Math.min(12, Math.max(1, (m.W / 240) * m.zoom)) * (4 / 9);
  // 两级参考网格：先铺 16×16 的淡小网格（每个 1/4 大格再 4 分），再压 4×4 大网格。
  // 小网格颜色比大网格更淡，只用来读 UV 间距，不会和白色 UV 岛线抢对比；
  // 落在 1/4 大格线上的那几根跳过，免得两层叠在同一像素上反而变亮。
  ctx.strokeStyle = 'rgba(150,170,195,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 1; k < 16; k++) {
    if (k % 4 === 0) continue;
    const x = Math.round(m.x(k / 16)) + 0.5, y = Math.round(m.y(k / 16)) + 0.5;
    ctx.moveTo(m.x(0), y); ctx.lineTo(m.x(1), y);
    ctx.moveTo(x, m.y(0)); ctx.lineTo(x, m.y(1));
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(150,170,195,0.20)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 4; k++) {
    const x = m.x(k / 4), y = m.y(k / 4);
    ctx.moveTo(m.x(0), y); ctx.lineTo(m.x(1), y);
    ctx.moveTo(x, m.y(0)); ctx.lineTo(x, m.y(1));
  }
  ctx.stroke();
  // 0~1 方框边界改浅灰（#b9c4d2 / 85%）：青色留给选中态，边界只当参考线。
  ctx.strokeStyle = 'rgba(185,196,210,0.85)';
  ctx.strokeRect(m.x(0) + 0.5, m.y(0) + 0.5, m.x(1) - m.x(0), m.y(1) - m.y(0));
  const drawBox = () => {
    if (!box) return;
    const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1);
    const bw = Math.abs(box.x1 - box.x0), bh = Math.abs(box.y1 - box.y0);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = selectionColor;
    ctx.fillStyle = 'rgba(124,224,255,0.10)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    ctx.restore();
  };
  if (!uv || !uv.length) { drawBox(); return { drawn: 0, total: 0 }; }
  const total = uv.length / 6;
  const sel = asSelection(selection);
  // 统一成一份标记集合：旧的面号集合 → 'f:t:0'；marks 已是键集合时直接用
  const markSet = marks instanceof Set ? marks
    : (Array.isArray(marks) ? new Set(marks.map(String))
      : (sel ? new Set([...sel].map((t) => uvMarkKey('face', t))) : null));
  const pickedFaces = new Path2D(), pickedEdges = new Path2D();
  const allDots = new Path2D(), pickedDots = [];
  const dotR = Math.min(4, Math.max(1.4, 1.4 * lw));
  const dotPickedR = Math.min(9, Math.max(2.6, 2.4 * lw));
  const normalBatches = [], seamBatches = [];
  let normal = new Path2D(), seams = new Path2D();
  const pushBatch = () => {
    normalBatches.push(normal);
    seamBatches.push(seams);
    normal = new Path2D();
    seams = new Path2D();
  };
  // Preserve the complete layout. Reject only triangles outside the viewport,
  // including a margin for selected edges and vertex markers.
  const margin = Math.max(dotPickedR, lw) + 1;
  const left = m.u(-margin), right = m.u(w + margin);
  const top = m.v(-margin), bottom = m.v(h + margin);
  let drawn = 0;
  for (let t = 0; t < total; t++) {
    const o = t * 6;
    const u0 = uv[o], v0 = uv[o+1], u1 = uv[o+2], v1 = uv[o+3], u2 = uv[o+4], v2 = uv[o+5];
    if ((u0 < left && u1 < left && u2 < left) || (u0 > right && u1 > right && u2 > right) ||
        (v0 < top && v1 < top && v2 < top) || (v0 > bottom && v1 > bottom && v2 > bottom)) continue;
    const x0 = m.x(u0), y0 = m.y(v0);
    const x1 = m.x(u1), y1 = m.y(v1);
    const x2 = m.x(u2), y2 = m.y(v2);
    const xs = [x0, x1, x2], ys = [y0, y1, y2];
    for (let j=0;j<3;j++) {
      const path = seamFlags?.[t*3+j] ? seams : normal;
      path.moveTo(xs[j],ys[j]); path.lineTo(xs[(j+1)%3],ys[(j+1)%3]);
    }
    if (element === 'vertex') {
      for (let j = 0; j < 3; j++) { allDots.moveTo(xs[j] + dotR, ys[j]); allDots.arc(xs[j], ys[j], dotR, 0, Math.PI * 2); }
    }
    // 选中的面 / 边 / 点：三种元素各画各的高亮层；'i'（整块 UV 岛）按面处理
    if (markSet) {
      if (markSet.has(uvMarkKey('face', t)) || markSet.has(uvMarkKey('island', t))) {
        // Match winding so overlapping or mirrored selected faces cannot cancel the fill.
        const clockwise = (x1-x0)*(y2-y0) >= (x2-x0)*(y1-y0);
        pickedFaces.moveTo(x0, y0);
        pickedFaces.lineTo(clockwise ? x1 : x2, clockwise ? y1 : y2);
        pickedFaces.lineTo(clockwise ? x2 : x1, clockwise ? y2 : y1);
        pickedFaces.closePath();
      }
      for (let j = 0; j < 3; j++) {
        if (markSet.has(uvMarkKey('edge', t, j))) {
          const j2 = (j + 1) % 3;
          pickedEdges.moveTo(xs[j], ys[j]); pickedEdges.lineTo(xs[j2], ys[j2]);
        }
        if (markSet.has(uvMarkKey('vertex', t, j))) pickedDots.push([xs[j], ys[j]]);
      }
    }
    if (++drawn % 512 === 0) pushBatch();
  }
  if (drawn % 512 !== 0) pushBatch();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  for (const path of normalBatches) ctx.stroke(path);
  ctx.strokeStyle = UV_COLORS.seam;
  for (const path of seamBatches) ctx.stroke(path);
  if (element === 'vertex') { ctx.fillStyle = color; ctx.fill(allDots); }
  ctx.save();
  // 选中的面整片填一层半透明青，再描同色亮边：和模型上 isPicked() 的观感一致。
  // 选中线只换颜色，线宽和普通 UV 线一模一样（lw），不再 2×lw 加粗。
  ctx.fillStyle = 'rgba(124, 224, 255, 0.22)';
  ctx.fill(pickedFaces);
  ctx.strokeStyle = selectionColor;
  ctx.lineWidth = lw;
  ctx.stroke(pickedFaces);
  ctx.stroke(pickedEdges);
  ctx.fillStyle = selectionColor;
  for (const [x, y] of pickedDots) {
    ctx.beginPath(); ctx.arc(x, y, dotPickedR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  drawBox();
  return { drawn, total, lineWidth: lw, selectionLineWidth: lw };
}

// 在 UV 面板里点一下：找出鼠标所在的那一个三角形（重心坐标判定）。
// 命中的面会回到 3D 视图里高亮，这就是「选 UV 线框 → 看到模型上对应的那条线」。
export function pickUvTriangle(uv, u, v, maxTris = Infinity) {
  if (!uv || !uv.length) return -1;
  const total = uv.length / 6;
  const stride = Math.max(1, Math.ceil(total / maxTris));
  for (let t = 0; t < total; t += stride) {
    const o = t * 6;
    const ax = uv[o], ay = uv[o + 1], bx = uv[o + 2], by = uv[o + 3], cx = uv[o + 4], cy = uv[o + 5];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
    const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -0.002 && l2 >= -0.002 && l3 >= -0.002) return t;
  }
  return -1;
}

// 框选：矩形给 UV 空间（u0,v0,u1,v1），三个顶点或重心任一落在框里就算选中。
// 默认检查完整 UV 网格，和展开图 / 单选保持一致。
export function pickUvTrianglesInRect(uv, rect, maxTris = Infinity) {
  if (!uv || !uv.length || !rect) return [];
  const u0 = Math.min(rect.u0, rect.u1), u1 = Math.max(rect.u0, rect.u1);
  const v0 = Math.min(rect.v0, rect.v1), v1 = Math.max(rect.v0, rect.v1);
  const inside = (x, y) => x >= u0 && x <= u1 && y >= v0 && y <= v1;
  const total = uv.length / 6;
  const stride = Math.max(1, Math.ceil(total / maxTris));
  const out = [];
  for (let t = 0; t < total; t += stride) {
    const o = t * 6;
    const ax = uv[o], ay = uv[o + 1], bx = uv[o + 2], by = uv[o + 3], cx = uv[o + 4], cy = uv[o + 5];
    if (inside(ax, ay) || inside(bx, by) || inside(cx, cy) ||
        inside((ax + bx + cx) / 3, (ay + by + cy) / 3)) out.push(t);
  }
  return out;
}

// ---- 元素选择：点 / 线 / 面 --------------------------------------------------
// tol 是 UV 空间的容差（由调用方按「画布 8px / (有效宽 × zoom)」换算，缩放后手感一致）。
// 三种元素共用同一份抽样步长，选中的下标就是模型里真正画出来的那批面。
const segDist = (u, v, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / len2)) : 0;
  return Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
};

export function pickUvElement(uv, u, v, { element = 'face', tol = 0.02, maxTris = Infinity } = {}) {
  if (!uv || !uv.length) return null;
  const total = uv.length / 6;
  const stride = Math.max(1, Math.ceil(total / maxTris));
  const lim = Math.max(1e-6, Number(tol) || 0.02);
  let best = null, bestD = Infinity;
  for (let t = 0; t < total; t += stride) {
    const o = t * 6;
    if (element === 'face') {
      const ax = uv[o], ay = uv[o + 1], bx = uv[o + 2], by = uv[o + 3], cx = uv[o + 4], cy = uv[o + 5];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
      const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
      if (l1 >= -0.002 && l2 >= -0.002 && 1 - l1 - l2 >= -0.002) return { kind: 'face', tri: t, idx: 0 };
    } else if (element === 'vertex') {
      for (let j = 0; j < 3; j++) {
        const d = Math.hypot(uv[o + j * 2] - u, uv[o + j * 2 + 1] - v);
        if (d <= lim && d < bestD) { bestD = d; best = { kind: 'vertex', tri: t, idx: j }; }
      }
    } else {
      for (let j = 0; j < 3; j++) {
        const j2 = (j + 1) % 3;
        const d = segDist(u, v, uv[o + j * 2], uv[o + j * 2 + 1], uv[o + j2 * 2], uv[o + j2 * 2 + 1]);
        if (d <= lim && d < bestD) { bestD = d; best = { kind: 'edge', tri: t, idx: j }; }
      }
    }
  }
  return best;
}

// 框选：三种元素各自按「落进 UV 矩形」收集标记，返回 mark 对象数组（不是键）。
export function pickUvElementsInRect(uv, rect, { element = 'face', maxTris = Infinity } = {}) {
  if (!uv || !uv.length || !rect) return [];
  const u0 = Math.min(rect.u0, rect.u1), u1 = Math.max(rect.u0, rect.u1);
  const v0 = Math.min(rect.v0, rect.v1), v1 = Math.max(rect.v0, rect.v1);
  const inside = (x, y) => x >= u0 && x <= u1 && y >= v0 && y <= v1;
  // 线段与闭矩形相交：裁剪参数区间，而不是只检查端点 / 中点。
  // 包含穿框、擦边、接触角点及退化线段；包围盒重叠但线段未穿框不会误选。
  const crosses = (ax, ay, bx, by) => {
    if (![ax, ay, bx, by].every(Number.isFinite)) return false;
    let lo = 0, hi = 1;
    const clipAxis = (a, b, min, max) => {
      const d = b - a;
      if (d === 0) return a >= min && a <= max;
      const t0 = (min - a) / d, t1 = (max - a) / d;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
      return lo <= hi;
    };
    return clipAxis(ax, bx, u0, u1) && clipAxis(ay, by, v0, v1);
  };
  if (element === 'face') {
    return pickUvTrianglesInRect(uv, rect, maxTris).map((tri) => ({ kind: 'face', tri, idx: 0 }));
  }
  const total = uv.length / 6;
  const stride = Math.max(1, Math.ceil(total / maxTris));
  const out = [];
  for (let t = 0; t < total; t += stride) {
    const o = t * 6;
    if (element === 'vertex') {
      for (let j = 0; j < 3; j++) {
        if (inside(uv[o + j * 2], uv[o + j * 2 + 1])) out.push({ kind: 'vertex', tri: t, idx: j });
      }
    } else {
      for (let j = 0; j < 3; j++) {
        const j2 = (j + 1) % 3;
        const ax = uv[o + j * 2], ay = uv[o + j * 2 + 1];
        const bx = uv[o + j2 * 2], by = uv[o + j2 * 2 + 1];
        if (crosses(ax, ay, bx, by)) {
          out.push({ kind: 'edge', tri: t, idx: j });
        }
      }
    }
    if (out.length >= 20000) break;   // 大网格框全图时的上限，别把主线程卡死
  }
  return out;
}

// 同一个 UV 点 / 边常被多个三角共用：把它们一并高亮，模型上才看得出「这块 UV」属于谁。
export function uvSharedTriangles(uv, mark, maxTris = 6000) {
  const set = new Set();
  if (!uv || !uv.length || !mark) return set;
  set.add(mark.tri);
  if (mark.kind === 'face') return set;
  const total = uv.length / 6;
  const stride = Math.max(1, Math.ceil(total / maxTris));
  const o0 = mark.tri * 6;
  const j2 = (mark.idx + 1) % 3;
  const au = uv[o0 + mark.idx * 2], av = uv[o0 + mark.idx * 2 + 1];
  const bu = uv[o0 + j2 * 2], bv = uv[o0 + j2 * 2 + 1];
  const same = (a, b) => Math.abs(a - b) < 1e-4;
  for (let t = 0; t < total; t += stride) {
    if (t === mark.tri) continue;
    const o = t * 6;
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      const match = mark.kind === 'vertex'
        ? same(uv[o + j * 2], au) && same(uv[o + j * 2 + 1], av)
        : ((same(uv[o + j * 2], au) && same(uv[o + j * 2 + 1], av) &&
            same(uv[o + k * 2], bu) && same(uv[o + k * 2 + 1], bv)) ||
           (same(uv[o + j * 2], bu) && same(uv[o + j * 2 + 1], bv) &&
            same(uv[o + k * 2], au) && same(uv[o + k * 2 + 1], av)));
      if (match) { set.add(t); break; }
    }
  }
  return set;
}

// Cache the connected components of the full UV channel. Box selection can
// touch many triangles in the same island, so expand all seeds in one pass.
const uvIslandCache = new WeakMap();
export function uvIslandTriangles(uv, seeds) {
  const out = new Set();
  if (!uv?.length) return out;
  const total = uv.length / 6;
  const selected = (Number.isInteger(seeds) ? [seeds] : Array.from(seeds || []))
    .filter(tri => Number.isInteger(tri) && tri >= 0 && tri < total);
  if (!selected.length) return out;
  let component = uvIslandCache.get(uv);
  if (!component) {
    component = new Int32Array(total);
    const byVertex = new Map();
    const root = (tri) => {
      while (component[tri] !== tri) {
        component[tri] = component[component[tri]];
        tri = component[tri];
      }
      return tri;
    };
    for (let tri = 0; tri < total; tri++) {
      component[tri] = tri;
      for (let j = tri * 6; j < tri * 6 + 6; j += 2) {
        const key = `${Math.round(uv[j] * 1e4)},${Math.round(uv[j + 1] * 1e4)}`;
        const neighbor = byVertex.get(key);
        if (neighbor === undefined) byVertex.set(key, tri);
        else component[root(tri)] = root(neighbor);
      }
    }
    for (let tri = 0; tri < total; tri++) component[tri] = root(tri);
    uvIslandCache.set(uv, component);
  }
  const roots = new Set(selected.map(tri => component[tri]));
  for (let tri = 0; tri < total; tri++) if (roots.has(component[tri])) out.add(tri);
  return out;
}

// 小工具：FBX ASCII 的数组块。值按 12 个一行写，自己的 fbxParseAscii 也能读回来。
function fbxArrayNode(name, values, indent) {
  const t = '\t'.repeat(indent);
  const lines = [];
  for (let i = 0; i < values.length; i += 12) {
    lines.push(`${t}\ta: ${values.slice(i, i + 12).map(fbxNum).join(',')}`);
  }
  return `${t}${name}: *${values.length}  {\n${lines.join('\n')}\n${t}}`;
}

function fbxNum(v) {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

const fbxSafe = (s) => String(s || '').replace(/["\\\r\n]/g, '_');

// 导出 FBX 7.4 ASCII：几何 + 当前选中 UV 通道（已应用旋转 / 镜像）+ 可选贴图引用。
//
// 几何按「逐三角形展开」写（和内部 pos 一一对应，不做顶点焊接）：PolygonVertexIndex
// 就是 0,1,2… 每个面最后一位取负，UV 用 ByPolygonVertex + IndexToDirect 直接对上，
// 不会因为焊接顶点把接缝 UV 合并掉 —— 这份文件本来就是拿来核对 UV 的。
// 坐标用 restPos 和 normalize 反算回文件原始尺度，不把预览里那套「最长边 = 2」带出去。
export function exportFbxAscii(model, opts = {}) {
  if (!model || !model.triangles) throw new Error('没有可导出的网格');
  const T = model.triangles;
  const pos = model.restPos || model.pos;
  const uv = opts.uv || model.uv;
  if (!uv || uv.length !== T * 6) throw new Error('UV 通道和三角面数对不上');
  const name = fbxSafe(opts.name || 'PudiViewMesh');
  const uvName = fbxSafe(opts.uvName || 'UV0');
  const texName = opts.textureName ? fbxSafe(opts.textureName) : '';
  const { center, k } = model.normalize || { center: [0, 0, 0], k: 1 };

  const verts = new Array(T * 9);
  for (let i = 0; i < T * 9; i += 3) {
    verts[i] = pos[i] / k + center[0];
    verts[i + 1] = pos[i + 1] / k + center[1];
    verts[i + 2] = pos[i + 2] / k + center[2];
  }
  const pvi = new Array(T * 3);
  const uvIndex = new Array(T * 3);
  const uvs = new Array(T * 6);
  for (let t = 0; t < T * 3; t++) {
    pvi[t] = (t + 1) % 3 === 0 ? -(t + 1) : t;
    uvIndex[t] = t;
  }
  for (let t = 0; t < T * 3; t++) {
    uvs[t * 2] = uv[t * 2];
    uvs[t * 2 + 1] = 1 - uv[t * 2 + 1];   // 左上 → FBX 左下
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const L = [];
  L.push('; FBX 7.4.0 project file');
  L.push('; Generated by PudiView UV tools');
  L.push(`; ${stamp}`);
  L.push('FBXHeaderExtension:  {');
  L.push('\tFBXHeaderVersion: 1003');
  L.push('\tFBXVersion: 7400');
  L.push('\tCreator: "PudiView UV Export"');
  L.push('}');
  L.push('GlobalSettings:  {');
  L.push('\tVersion: 1000');
  L.push('\tProperties70:  {');
  L.push('\t\tP: "UpAxis", "int", "Integer", "",1');
  L.push('\t\tP: "UpAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "FrontAxis", "int", "Integer", "",2');
  L.push('\t\tP: "FrontAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "CoordAxis", "int", "Integer", "",0');
  L.push('\t\tP: "CoordAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "UnitScaleFactor", "double", "Number", "",1');
  L.push('\t}');
  L.push('}');
  L.push('Definitions:  {');
  L.push('\tVersion: 100');
  L.push(`\tCount: ${texName ? 4 : 3}`);
  L.push('\tObjectType: "GlobalSettings"  {\n\t\tCount: 1\n\t}');
  L.push('\tObjectType: "Geometry"  {\n\t\tCount: 1\n\t}');
  L.push('\tObjectType: "Model"  {\n\t\tCount: 1\n\t}');
  L.push('\tObjectType: "Material"  {\n\t\tCount: 1\n\t}');
  if (texName) L.push('\tObjectType: "Texture"  {\n\t\tCount: 1\n\t}');
  L.push('}');
  L.push('Objects:  {');
  L.push(`\tGeometry: 1000, "Geometry::${name}", "Mesh"  {`);
  L.push('\t\tGeometryVersion: 124');
  L.push(fbxArrayNode('Vertices', verts, 2));
  L.push(fbxArrayNode('PolygonVertexIndex', pvi, 2));
  L.push('\t\tLayerElementUV: 0  {');
  L.push('\t\t\tVersion: 101');
  L.push(`\t\t\tName: "${uvName}"`);
  L.push('\t\t\tMappingInformationType: "ByPolygonVertex"');
  L.push('\t\t\tReferenceInformationType: "IndexToDirect"');
  L.push(fbxArrayNode('UV', uvs, 3));
  L.push(fbxArrayNode('UVIndex', uvIndex, 3));
  L.push('\t\t}');
  L.push('\t\tLayer: 0  {');
  L.push('\t\t\tVersion: 100');
  L.push('\t\t\tLayerElement:  {');
  L.push('\t\t\t\tType: "LayerElementUV"');
  L.push('\t\t\t\tTypedIndex: 0');
  L.push('\t\t\t}');
  L.push('\t\t}');
  L.push('\t}');
  L.push(`\tModel: 2000, "Model::${name}", "Mesh"  {`);
  L.push('\t\tVersion: 232');
  L.push('\t\tProperties70:  {');
  L.push('\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A+",0,0,0');
  L.push('\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A+",0,0,0');
  L.push('\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A+",1,1,1');
  L.push('\t\t}');
  L.push('\t}');
  L.push(`\tMaterial: 3000, "Material::${name}", ""  {`);
  L.push('\t\tVersion: 102');
  L.push('\t\tShadingModel: "phong"');
  L.push('\t\tMultiLayer: 0');
  L.push('\t\tProperties70:  {');
  L.push('\t\t\tP: "DiffuseColor", "Color", "", "A",0.8,0.8,0.8');
  L.push('\t\t}');
  L.push('\t}');
  if (texName) {
    L.push(`\tTexture: 4000, "Texture::${texName}", ""  {`);
    L.push('\t\tType: "TextureVideo"');
    L.push('\t\tVersion: 202');
    L.push(`\t\tTextureName: "Texture::${texName}"`);
    L.push(`\t\tFileName: "${texName}"`);
    L.push('\t\tModelUVTranslation: 0,0');
    L.push('\t\tModelUVScaling: 1,1');
    L.push('\t\tTexture_Alpha_Source: "None"');
    L.push('\t\tCropping: 0,0,0,0');
    L.push('\t}');
  }
  L.push('}');
  L.push('Connections:  {');
  L.push('\tC: "OO",1000,2000');
  L.push('\tC: "OO",3000,2000');
  if (texName) L.push('\tC: "OP",4000,3000,"DiffuseColor"');
  L.push('\tC: "OO",2000,0');
  L.push('}');
  L.push('');
  return L.join('\n');
}

export function fbxToBytes(text) {
  return new TextEncoder().encode(text);
}

// Export UV 0..1 at texture coordinates, independent of panel pan/zoom and selection.
export function drawUvExport(ctx, uv, positions, size, edges = 'all') {
  if (![512,1024,2048].includes(size) || !['all','seams','visible','solid'].includes(edges)) throw new Error('无效的 UV 导出选项');
  const flags = uvSeamFlags(positions,uv);
  ctx.clearRect(0,0,size,size);
  if (edges === 'solid') {
    ctx.fillStyle = '#ffffff';
    const islands = new Path2D();
    for (let t = 0; t < uv.length; t += 6) {
      // Use a common winding so overlapping mirrored triangles never cancel.
      const cross = (uv[t+2]-uv[t])*(uv[t+5]-uv[t+1])-(uv[t+3]-uv[t+1])*(uv[t+4]-uv[t]);
      const order = cross < 0 ? [0,4,2] : [0,2,4];
      islands.moveTo(uv[t]*size, uv[t+1]*size);
      for (const j of order.slice(1)) islands.lineTo(uv[t+j]*size,uv[t+j+1]*size);
      islands.closePath();
    }
    ctx.fill(islands); return;
  }
  ctx.lineWidth = Math.max(1,size/240) * (4/9);
  ctx.lineJoin='round';
  for(const seam of [false,true]) {
    ctx.strokeStyle=seam && edges !== 'visible' ? UV_COLORS.seam : UV_COLORS.line;
    // Bounded batches keep large exports from creating an enormous single path.
    ctx.beginPath();let count=0;
    for(let t=0;t<uv.length/6;t++)for(let j=0;j<3;j++) {
      if(Boolean(flags[t*3+j])!==seam)continue;
      const a=t*6+j*2,b=t*6+((j+1)%3)*2;
      ctx.moveTo(uv[a]*(size-1)+.5,uv[a+1]*(size-1)+.5);
      ctx.lineTo(uv[b]*(size-1)+.5,uv[b+1]*(size-1)+.5);
      if(++count%4096===0){ctx.stroke();ctx.beginPath();}
    }
    ctx.stroke();
  }
}
