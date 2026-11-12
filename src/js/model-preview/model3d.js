import { MODEL_LINE_WIDTH, NORMAL_ARROW_COLORS, rasterizeModelSurface } from './model-surface.js';
import { UV_COLORS, parseUvMark } from './model-uv.js';
import { groupNormals, transformNormal, shadeGradient, poseCornerNormals, vectorKey } from './model-shading.js';
import { previewVertices } from './model-topology.js';
// 迁移自 pudi-view 的 3D 网格解析和预览。

import { openZip, findZipEntry, readZipEntry } from './zip.js';
// 网格表用于 Canvas 2D 合成。支持时用 WebGL 批量绘制表面，否则走 Canvas 2D 光栅化。
//
// 统一网格结构：
//   { format, label, triangles, vertices, materials, warnings,
//     pos: Float32Array(9*T),  // 每个三角形 3 个顶点，已归一化到最长边 2
//     nrm: Float32Array(3*T),  // 面法线（单位向量）
//     col: Uint8Array(3*T),    // 基色
//     uvSets: [{ name, uv: Float32Array(6*T), generated }],  // 多套 UV（每三角 3 组 u,v）
//     uv: uvSets[0].uv,        // 当前主通道的快捷引用
//     bounds: { min, max, size } }
//
// UV 口径统一为「原点左上」（v 向下），和 canvas / WebGL 贴图坐标一致：
// OBJ 的 vt、FBX 的 LayerElementUV 都是原点左下，解析时翻 1-v；glTF 的 TEXCOORD 本来就是左上。

// 流畅预览支持的格式；工具箱的完整格式表还包括 WebGL 检查模式的加载器。
export const MODEL_EXTS = ['obj', 'glb', 'gltf', 'stl', 'ply', '3mf', 'fbx', 'dae', '3ds', 'amf'];

const MAX_TRIS = 250000;      // 解析上限：再大就不放进来了，避免假头把页面撑爆
const DRAW_FULL = 30000;     // 静止时一帧最多画多少面
const DRAW_DRAFT = 10000;    // 拖动 / 自动旋转时的草稿档
const WIRE_CHUNK = 16;       // 线框批量：攒够多少面的边 stroke 一次。实测 Skia stroke 对超大批量
                             // 路径超线性变慢（整帧一次反而秒级），16 面/批是调用开销与路径开销的平衡点
const DEFAULT_COLOR = [176, 186, 202];
const WIRE_COLOR = '#7ce0ff';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const dec = new TextDecoder('utf-8');
const textOf = (b) => dec.decode(b);

function dataUriBytes(uri) {
  const m = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!m) return null;
  if (!/;base64/i.test(m[1])) {
    try { return new TextEncoder().encode(decodeURIComponent(m[2])); } catch (_) { return null; }
  }
  try {
    const bin = atob(m[2].replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) { return null; }
}

// 收集三角形：一边收一边算面法线，最后统一归一化坐标
class MeshBuilder {
  constructor(format, label) {
    this.format = format;
    this.label = label;
    this.pos = [];
    this.nrm = [];
    this.cornerNrm = [];
    this.hasSourceNormals = false;
    this.sourceNormalMask = [];
    this.col = [];
    this.uvSets = [];   // [{ name, data: [] }]：每套 UV 按三角形攒 6 个 float
    this.vertices = 0;
    this.boneCount = 0;
    this.materials = new Set();
    this.warnings = [];
    // 模型自己的原点（物体枢轴）在「未归一化 raw 坐标」里的位置。带节点层级的格式
    // 在发射三角形时把节点世界矩阵作用于局部 (0,0,0) 记下来；纯顶点格式没有这层信息。
    // 注意这不是文件世界的 (0,0,0)：物体位置没归零时两者会差很远，见 modelOrigin()。
    this.origin = null;
    // 同一个主网格节点的「物体级」变换矩阵（已剥掉格式级 base），供模型信息里的
    // 变换诊断分解用；纯顶点格式不调 setOriginFromMatrix，这里就一直是 null。
    this.nodeTransform = null;
  }

  // 取第一个真正画出三角形的网格节点作主枢轴，多物体文件按主网格显示。
  // 列主序 4x4 的第 4 列就是局部 (0,0,0) 变换后的世界位置。
  // base 是格式级的全局变换（FBX 的 UpAxis / UnitScale、DAE 的 up_axis），不属于
  // 物体变换：剥掉后再分解，缩放 / 旋转才不会被单位换算和换轴误判。glTF / 3MF
  // 没有这层全局变换，base 留空即按单位阵处理。
  setOriginFromMatrix(m, base) {
    if (!m) return;
    if (!this.origin) {
      const p = applyMat(m, [0, 0, 0]);
      if (p.length === 3 && p.every(Number.isFinite)) this.origin = p;
    }
    if (!this.nodeTransform) this.nodeTransform = matMul(matInv(base || IDENT()), m);
  }

  // uvs 可选：按通道顺序给一组 [u0,v0,u1,v1,u2,v2]。某个三角形缺通道就补零，
  // finish() 再统一补齐长度——各格式解析器不必自己记账，也不会因为漏一面就整体错位。
  addTri(a, b, c, color, uvs, corners) {
    if (this.pos.length / 9 >= MAX_TRIS) throw new Error(`模型超过 ${MAX_TRIS} 面，本站只预览小中型网格`);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) return false; // 退化三角形直接丢
    nx /= len; ny /= len; nz /= len;
    for (let j = 0; j < 3; j++) {
      const corner = corners?.[j];
      const length = corner ? Math.hypot(...corner) : 0;
      const valid = Number.isFinite(length) && length > 1e-12;
      this.sourceNormalMask.push(valid ? 1 : 0);
      if (valid) {
        this.cornerNrm.push(...corner.map((value) => value / length));
        this.hasSourceNormals = true;
      } else {
        this.cornerNrm.push(nx, ny, nz);
      }
    }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(nx, ny, nz);
    const col = color || DEFAULT_COLOR;
    this.col.push(clamp255(col[0]), clamp255(col[1]), clamp255(col[2]));
    const nSet = uvs ? uvs.length : 0;
    while (this.uvSets.length < nSet) {
      this.uvSets.push({ name: `UV${this.uvSets.length}`, data: [] });
    }
    const need = (this.pos.length / 9 - 1) * 6;
    for (let s = 0; s < this.uvSets.length; s++) {
      const set = this.uvSets[s];
      while (set.data.length < need) set.data.push(0, 0, 0, 0, 0, 0);
      const q = uvs && uvs[s];
      if (q && q.length === 6) set.data.push(q[0], q[1], q[2], q[3], q[4], q[5]);
      else set.data.push(0, 0, 0, 0, 0, 0);
    }
    return true;
  }

  warn(s) { if (!this.warnings.includes(s)) this.warnings.push(s); }

  finish() {
    const n = this.pos.length / 9;
    if (!n) throw new Error('这个文件里没有可显示的三角形');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = this.pos[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const edge = Math.max(size[0], size[1], size[2], 1e-6);
    const k = 2 / edge;
    const pos = new Float32Array(this.pos.length);
    for (let i = 0; i < this.pos.length; i += 3) {
      pos[i] = (this.pos[i] - center[0]) * k;
      pos[i + 1] = (this.pos[i + 1] - center[1]) * k;
      pos[i + 2] = (this.pos[i + 2] - center[2]) * k;
    }
    // 归一化后每个顶点的 y 已经落进 [-1,1]（最长边 = 2），取最低点当作「地面」，
    // 3D 预览的网格就铺在这一高度上，模型像「站」在网格上。
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) if (pos[i] < minY) minY = pos[i];

    // ---- UV 通道：补齐长度，没有 UV 的格式给一套自动投影兜底 ----
    let uvSets = this.uvSets.map((s, i) => {
      const data = s.data.slice(0, n * 6);
      while (data.length < n * 6) data.push(0);
      return { name: s.name || `UV${i}`, uv: Float32Array.from(data), generated: false };
    });
    // STL / PLY / 3MF / DAE / 3DS / AMF 这些本来就不带纹理坐标。给一套按 XZ 平面
    // 投影的 UV，导入贴图在每种格式上都有落点；UI 里标明是自动生成的，别当成文件自带的。
    const noUv = !uvSets.length || uvSets.every((s) => {
      for (let k = 0; k < s.uv.length; k++) if (s.uv[k] !== 0) return false;
      return true;
    });
    if (noUv) {
      const uv = new Float32Array(n * 6);
      for (let t = 0; t < n; t++) {
        for (let j = 0; j < 3; j++) {
          uv[t * 6 + j * 2] = Math.min(1, Math.max(0, (pos[t * 9 + j * 3] + 1) / 2));
          uv[t * 6 + j * 2 + 1] = Math.min(1, Math.max(0, (pos[t * 9 + j * 3 + 2] + 1) / 2));
        }
      }
      uvSets = [{ name: 'UV0（自动投影）', uv, generated: true }, ...uvSets];
    }
    // 模型自身原点（物体枢轴）在预览坐标系里的位置。带节点变换的格式用解析时记下的
    // pivot；纯顶点格式（OBJ / STL / PLY / 3DS / AMF）没有物体枢轴这层信息，文件里的
    // (0,0,0) 只是世界原点，顶点整体带偏移时把 gizmo 甩到世界中心是错的，改用包围盒
    // 中心（预览坐标系的 [0,0,0]）作模型原点的近似。pivot 恰为 (0,0,0) 时同理。
    const pivot = this.origin;
    const hasPivot = pivot && (Math.abs(pivot[0]) + Math.abs(pivot[1]) + Math.abs(pivot[2])) > 1e-12;
    const origin = hasPivot
      ? [(pivot[0] - center[0]) * k, (pivot[1] - center[1]) * k, (pivot[2] - center[2]) * k]
      : [0, 0, 0];
    // 变换诊断：分解主网格节点的物体级矩阵，回答「变换是否已重置 / 缩放 XYZ 是否
    // 都是 1 / 坐标是否在 0 点」。纯顶点格式（OBJ / STL / PLY / 3DS / AMF）文件里
    // 没有物体变换这层信息，supported:false 如实标注，另给 raw 顶点包围盒中心作
    // 参考 —— 变换被烘焙进顶点时能从这里看出整体有没有偏移。
    const tf = decomposeTransform(this.nodeTransform);
    const geomCenter = center.slice();
    const transform = {
      supported: !!tf,
      translation: tf ? tf.translation : null,
      scale: tf ? tf.scale : null,
      hasRotation: tf ? tf.hasRotation : false,
      mirrored: tf ? tf.mirrored : false,
      degenerate: tf ? tf.degenerate : false,
      atOrigin: tf ? tf.atOrigin : null,
      unitScale: tf ? tf.unitScale : null,
      reset: tf ? tf.reset : null,
      geomCenter,
      geomAtOrigin: geomCenter.every((v) => Math.abs(v) < TF_EPS),
    };
    return {
      format: this.format,
      label: this.label,
      triangles: n,
      vertices: this.vertices || n * 3,
      boneCount: this.boneCount,
      materials: this.materials.size,
      warnings: this.warnings,
      pos,
      nrm: Float32Array.from(this.nrm),
      cornerNrm: this.hasSourceNormals ? Float32Array.from(this.cornerNrm) : null,
      restCornerNrm: this.hasSourceNormals ? Float32Array.from(this.cornerNrm) : null,
      sourceNormalMask: this.hasSourceNormals ? Uint8Array.from(this.sourceNormalMask) : null,
      hasSourceNormals: this.hasSourceNormals,
      col: Uint8Array.from(this.col),
      uvSets,
      uv: uvSets[0].uv,
      bounds: { min, max, size },
      minY,
      // 动画播放时要把「模型空间原始坐标」重新套用同一套归一化，别让画面缩放跳一下
      normalize: { center, k, origin },
      transform,
      restPos: pos.slice(),
      restNrm: Float32Array.from(this.nrm),
    };
  }
}

// ---------------- OBJ ----------------

function parseMtl(text) {
  const out = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^newmtl\s/i.test(t)) { cur = t.slice(6).trim(); out.set(cur, DEFAULT_COLOR.slice()); }
    else if (cur && /^Kd\s/i.test(t)) {
      const p = t.split(/\s+/).slice(1, 4).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) out.set(cur, p.map((v) => clamp255(v * 255)));
    }
  }
  return out;
}

async function parseObj(bytes, resolveUri) {
  const text = textOf(bytes);
  const lines = text.split(/\r?\n/);
  const mb = new MeshBuilder('obj', 'Wavefront OBJ');
  const vs = [];   // [x,y,z] 或 [x,y,z,r,g,b]
  const vns = [];
  const vts = [];  // [u,v]：OBJ 的纹理坐标，原点左下，读进来翻成左上
  // mtllib 一般写在文件头、面写在后面，所以先单独扫一遍把材质表备齐，
  // 第二遍解析面时 usemtl 才能立刻拿到颜色（不用回头改已经写进缓冲区的像素）。
  let mats = new Map();
  let hadMtl = false;
  for (const line of lines) {
    const t = line.trim();
    if (!/^mtllib\s/i.test(t)) continue;
    for (const f of t.split(/\s+/).slice(1)) {
      const b = await resolveUri(f);
      if (!b) { mb.warn(`配套的材质库读不到：${f}`); continue; }
      for (const [k, v] of parseMtl(textOf(b))) { mats.set(k, v); hadMtl = true; }
    }
  }
  let color = DEFAULT_COLOR.slice();
  let smoothing = null; const objFaces = [], objGroups = [], objTriangles = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    if (/^mtllib\s/i.test(t)) continue;
    if (/^v\s/.test(t)) {
      const p = t.split(/\s+/).slice(1).map(Number);
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
        vs.push(p.length >= 6 && p.slice(3, 6).every(Number.isFinite)
          ? [p[0], p[1], p[2], p[3] * 255, p[4] * 255, p[5] * 255]
          : [p[0], p[1], p[2]]);
      }
      continue;
    }
    if (/^vn\s/.test(t)) {
      const p = t.split(/\s+/).slice(1, 4).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) vns.push(p);
      continue;
    }
    if (/^vt\s/.test(t)) {
      const p = t.split(/\s+/).slice(1, 3).map(Number);
      if (p.length >= 2 && p.slice(0, 2).every(Number.isFinite)) vts.push([p[0], 1 - p[1]]);
      continue;
    }
    if (/^usemtl\s/i.test(t)) {
      const name = t.slice(6).trim();
      mb.materials.add(name);
      color = mats.get(name) || DEFAULT_COLOR.slice();
      continue;
    }
    if (/^s\s/.test(t)) { const g=t.split(/\s+/)[1]; smoothing=(g==='off'||g==='0')?null:g; continue; }
    if (!/^f\s/.test(t)) continue;
    const parts = t.split(/\s+/).slice(1);
    const idx = [];
    for (const p of parts) {
      const f = p.split('/');
      const at = (raw, len) => {
        const v = parseInt(raw, 10);
        if (!Number.isFinite(v) || v === 0) return -1;
        return v < 0 ? len + v : v - 1;
      };
      idx.push({ v: at(f[0], vs.length), t: f[1] ? at(f[1], vts.length) : -1, n: f[2] ? at(f[2], vns.length) : -1 });
    }
    if (idx.length < 3) continue;
    const faceIndex=objFaces.length; objFaces.push(idx.map(q=>q.v));objGroups.push(smoothing);
    for (let k = 1; k < idx.length - 1; k++) {
      const tri = [idx[0], idx[k], idx[k + 1]];
      if (tri.some((q) => q.v < 0 || !vs[q.v])) continue;
      const a = vs[tri[0].v], b = vs[tri[1].v], c = vs[tri[2].v];
      const ns = tri.map((q) => (q.n >= 0 ? vns[q.n] : null));
      const vc = [a, b, c].every((v) => v.length >= 6)
        ? [(a[3] + b[3] + c[3]) / 3, (a[4] + b[4] + c[4]) / 3, (a[5] + b[5] + c[5]) / 3]
        : color;
      // OBJ 只有一套 vt；三个角都带 vt 才给 UV，缺一个就整面补零（finish 里会兜底）
      const uvs = tri.every((q) => q.t >= 0 && vts[q.t])
        ? [[vts[tri[0].t][0], vts[tri[0].t][1], vts[tri[1].t][0], vts[tri[1].t][1],
            vts[tri[2].t][0], vts[tri[2].t][1]]]
        : [];
      objTriangles.push({a,b,c,vc,uvs,ns,faceIndex,corners:[0,k,k+1]});
    }
  }
  const objNormals = objGroups.some(Boolean) ? groupNormals(vs, objFaces, objGroups) : null;
  for (const t of objTriangles) {
    const corners = t.ns.map((normal, j) => normal || (objGroups[t.faceIndex]
      ? objNormals[t.faceIndex][t.corners[j]] : null));
    mb.addTri(t.a, t.b, t.c, t.vc, t.uvs, corners);
  }
  if (hadMtl) mb.warn('OBJ 顶点自带颜色与 MTL 材质色冲突时以 MTL 为准');
  mb.vertices = vs.length;
  return mb.finish();
}

// ---------------- STL ----------------

function parseStl(bytes) {
  const mb = new MeshBuilder('stl', 'STL 三角网格');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= 84 ? dv.getUint32(80, true) : 0;
  const binary = bytes.length >= 84 && count > 0 && 84 + count * 50 <= bytes.length + 8;
  if (binary) {
    mb.label = 'STL 二进制三角网格';
    const f = (off) => dv.getFloat32(off, true);
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50;
      if (o + 48 > bytes.length) break;
      const a = [f(o + 12), f(o + 16), f(o + 20)];
      const b = [f(o + 24), f(o + 28), f(o + 32)];
      const c = [f(o + 36), f(o + 40), f(o + 44)];
      mb.addTri(a, b, c, DEFAULT_COLOR);
    }
    mb.vertices = count * 3;
  } else {
    const text = textOf(bytes);
    if (!/^\s*solid/i.test(text)) throw new Error('不是有效的 STL 文件（ASCII 或二进制都不是）');
    mb.label = 'STL ASCII 三角网格';
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    let m, tri = [];
    while ((m = re.exec(text))) {
      tri.push([+m[1], +m[2], +m[3]]);
      if (tri.length === 3) { mb.addTri(tri[0], tri[1], tri[2], DEFAULT_COLOR); tri = []; }
    }
    mb.vertices = mb.pos.length / 3;
  }
  return mb.finish();
}

// ---------------- glTF 压缩扩展解码（按需加载） ----------------
//
// 只在真的遇到 KHR_draco_mesh_compression / EXT_meshopt_compression 时才 import()，
// 普通模型不付加载代价；WASM 随 frontendDist 进包，但不进初始加载路径。
// 两者均为官方发行文件：meshoptimizer 1.3.0 (MIT)、draco3dgltf 1.5.9 (Apache-2.0)，
// 随包许可见 src/vendor/meshopt-LICENSE.md 和 src/vendor/draco-LICENSE.txt。

let meshoptPromise = null;
async function loadMeshopt() {
  if (!meshoptPromise) meshoptPromise = (async () => {
    const { MeshoptDecoder } = await import('../../vendor/meshopt_decoder.mjs');
    await MeshoptDecoder.ready;
    if (!MeshoptDecoder.supported) throw new Error('当前 WebView 不支持 meshopt 解码所需的 WebAssembly');
    return MeshoptDecoder;
  })().catch((e) => { meshoptPromise = null; throw e; });
  return meshoptPromise;
}

let dracoPromise = null;
async function loadDraco() {
  if (!dracoPromise) dracoPromise = (async () => {
    // 胶水是官方 Emscripten 输出（文件尾补了一行 ESM 导出），wasm 单独随包。
    const [mod, res] = await Promise.all([
      import('../../vendor/draco_decoder.mjs'),
      fetch(new URL('../../vendor/draco_decoder.wasm', import.meta.url)),
    ]);
    if (!res.ok) throw new Error('Draco 解码器 wasm 读不到');
    return mod.default({ wasmBinary: new Uint8Array(await res.arrayBuffer()) });
  })().catch((e) => { dracoPromise = null; throw e; });
  return dracoPromise;
}

// EXT_meshopt_compression：压缩数据挂在 bufferView 的扩展上，解码后就是一块普通
// bufferView 字节。按 bufferView 序号缓存，readAccessor 直接读解码结果。
async function decodeMeshoptViews(json, buffers) {
  const out = new Map();
  const views = json.bufferViews || [];
  let dec = null;
  for (let i = 0; i < views.length; i++) {
    const x = views[i].extensions && views[i].extensions.EXT_meshopt_compression;
    if (!x) continue;
    if (!dec) dec = await loadMeshopt();
    const src = buffers[x.buffer === undefined ? (views[i].buffer || 0) : x.buffer];
    if (!src) throw new Error('EXT_meshopt_compression 指向的 buffer 读不到');
    const off = x.byteOffset || 0, len = x.byteLength || 0;
    if (off < 0 || len < 0 || off + len > src.length) throw new Error('EXT_meshopt_compression 数据被截断');
    const count = x.count | 0, size = x.byteStride | 0;
    if (!(count > 0) || !(size > 0) || size > 256 || count > 20000000 || count * size > 256 * 1024 * 1024) {
      throw new Error('EXT_meshopt_compression 声明的尺寸不合理');
    }
    const target = new Uint8Array(count * size);
    dec.decodeGltfBuffer(target, count, size, src.subarray(off, off + len),
      x.mode || 'ATTRIBUTES', x.filter || 'NONE');
    out.set(i, target);
  }
  return out;
}

// KHR_draco_mesh_compression：一个 bufferView 存一段 Draco 码流，primitive 的扩展把
// POSITION / NORMAL / COLOR_0 映射到 Draco 的 attribute unique id。
async function decodeDracoPrimitive(bytes, attrIds) {
  const M = await loadDraco();
  const dec = new M.Decoder(), db = new M.DecoderBuffer(), mesh = new M.Mesh();
  try {
    db.Init(bytes, bytes.length);
    if (dec.GetEncodedGeometryType(db) !== M.TRIANGULAR_MESH) throw new Error('Draco 码流不是三角网格');
    const st = dec.DecodeBufferToMesh(db, mesh);
    if (!st.ok()) throw new Error(`Draco 解码失败：${st.error_msg()}`);
    const np = mesh.num_points(), nf = mesh.num_faces();
    if (!(np > 0) || !(nf > 0) || nf > MAX_TRIS || np > MAX_TRIS * 3) {
      throw new Error('Draco 网格尺寸不合理或超过面数上限');
    }
    const ptr = M._malloc(nf * 3 * 4);
    let indices;
    try {
      dec.GetTrianglesUInt32Array(mesh, nf * 3 * 4, ptr);
      indices = new Uint32Array(M.HEAPU8.buffer, ptr, nf * 3).slice();
    } finally { M._free(ptr); }
    const attrs = {};
    for (const name of Object.keys(attrIds || {})) {
      if (name !== 'POSITION' && name !== 'NORMAL' && name !== 'COLOR_0') continue;
      const a = dec.GetAttributeByUniqueId(mesh, attrIds[name]);
      if (!a || a.num_components() < 3) continue;
      const fa = new M.DracoFloat32Array();
      try {
        // GetAttributeFloatForAllPoints 会自动把量化属性反量化回浮点，正是 glTF 要的值
        if (!dec.GetAttributeFloatForAllPoints(mesh, a, fa) || fa.size() < np * a.num_components()) continue;
        const num = a.num_components(), data = new Float32Array(np * num);
        for (let i = 0; i < data.length; i++) data[i] = fa.GetValue(i);
        attrs[name] = { data, num, count: np };
      } finally { M.destroy(fa); }
    }
    return { indices, attrs };
  } finally {
    M.destroy(mesh); M.destroy(db); M.destroy(dec);
  }
}

// ---------------- glTF 2.0 ----------------

const CT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_OF = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readAccessor(gltf, buffers, index, decodedViews) {
  const a = gltf.accessors && gltf.accessors[index];
  if (!a) throw new Error(`glTF 缺少第 ${index} 号 accessor`);
  if (a.sparse) throw new Error('glTF 的 sparse accessor 暂不支持');
  const bv = gltf.bufferViews && gltf.bufferViews[a.bufferView];
  const decoded = decodedViews && decodedViews.get(a.bufferView);
  const mx = bv && bv.extensions && bv.extensions.EXT_meshopt_compression;
  const buf = decoded || (bv && buffers[bv.buffer || 0]);
  if (!buf) throw new Error('glTF 的 bufferView 指向的缓冲区读不到');
  const num = NUM_OF[a.type] || 0, bytes = CT[a.componentType] || 0;
  if (!num || !bytes || !a.count) throw new Error('glTF accessor 的 componentType / type 不认识');
  // 压缩视图的 byteStride 写在扩展里；解码后缓冲区已经从 bufferView 起点开始
  const stride = (bv && bv.byteStride) || (mx && mx.byteStride) || num * bytes;
  const base = decoded ? (a.byteOffset || 0) : ((bv && bv.byteOffset || 0)) + (a.byteOffset || 0);
  if (base + (a.count - 1) * stride + num * bytes > buf.length) throw new Error('glTF 缓冲区被截断');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(a.count * num);
  const norm = a.normalized;
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < num; k++) {
      const o = base + i * stride + k * bytes;
      let v;
      switch (a.componentType) {
        case 5120: v = dv.getInt8(o); if (norm) v = Math.max(v / 127, -1); break;
        case 5121: v = dv.getUint8(o); if (norm) v /= 255; break;
        case 5122: v = dv.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5123: v = dv.getUint16(o, true); if (norm) v /= 65535; break;
        case 5125: v = dv.getUint32(o, true); break;
        default: v = dv.getFloat32(o, true); break;
      }
      out[i * num + k] = v;
    }
  }
  return { data: out, num, count: a.count };
}

const IDENT = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // 列主序

function matMul(a, b) { // 列主序 4x4：out = a * b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// 列主序 4x4 求逆：只在加载时对绑定矩阵 / 蒙皮模板调用，用高斯消元即可
function matInv(m) {
  const a = [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]];
  const b = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let i = 0; i < 4; i++) {
    let piv = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
    if (!a[piv][i]) return IDENT();
    if (piv !== i) { const t = a[i]; a[i] = a[piv]; a[piv] = t; const t2 = b[i]; b[i] = b[piv]; b[piv] = t2; }
    const f = a[i][i];
    for (let c = 0; c < 4; c++) { a[i][c] /= f; b[i][c] /= f; }
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f2 = a[r][i];
      for (let c = 0; c < 4; c++) { a[r][c] -= f2 * a[i][c]; b[r][c] -= f2 * b[i][c]; }
    }
  }
  return [b[0][0], b[1][0], b[2][0], b[3][0], b[0][1], b[1][1], b[2][1], b[3][1], b[0][2], b[1][2], b[2][2], b[3][2], b[0][3], b[1][3], b[2][3], b[3][3]];
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice(0, 16);
  const t = n.translation || [0, 0, 0];
  const q = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function applyMat(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function materialColor(gltf, idx) {
  const mat = (gltf.materials || [])[idx];
  if (!mat) return DEFAULT_COLOR.slice();
  const pbr = mat.pbrMetallicRoughness || {};
  let f = pbr.baseColorFactor;
  if (!f && mat.extensions && mat.extensions.KHR_materials_pbrSpecularGlossiness) {
    f = mat.extensions.KHR_materials_pbrSpecularGlossiness.diffuseFactor;
  }
  if (!Array.isArray(f) || f.length < 3) return DEFAULT_COLOR.slice();
  return [f[0] * 255, f[1] * 255, f[2] * 255];
}

function triangleList(indices, vertexCount, mode) {
  // 返回 [i0,i1,i2,...]，mode 4 = TRIANGLES / 5 = STRIP / 6 = FAN
  if (mode === 5) {
    const out = [];
    for (let i = 2; i < indices.length; i++) {
      if (i % 2) out.push(indices[i], indices[i - 1], indices[i - 2]);
      else out.push(indices[i - 2], indices[i - 1], indices[i]);
    }
    return out;
  }
  if (mode === 6) {
    const out = [];
    for (let i = 2; i < indices.length; i++) out.push(indices[0], indices[i - 1], indices[i]);
    return out;
  }
  if (mode !== undefined && mode !== 4) return [];
  return indices;
}

async function parseGltf(bytes, ext, resolveUri) {
  let json, bin = null;
  if (ext === 'glb') {
    if (bytes.length < 20) throw new Error('GLB 文件太短');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB 文件（magic 不是 glTF）');
    const ver = dv.getUint32(4, true);
    if (ver !== 2) throw new Error(`只支持 glTF 2.0，这份是 ${ver}`);
    const total = dv.getUint32(8, true);
    if (total > bytes.length) throw new Error('GLB 声明的长度超过文件本身');
    let off = 12;
    while (off + 8 <= total) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      if (len < 0 || off + 8 + len > total) throw new Error('GLB 的 chunk 长度不合法');
      const body = bytes.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(textOf(body));       // 'JSON'
      else if (type === 0x004e4942) bin = body;                       // 'BIN\0'
      off += 8 + len + ((4 - (len % 4)) % 4); // 规范里 chunk 长度按 4 对齐，这行兜住不规范的写入器
    }
    if (!json) throw new Error('GLB 里没有 JSON chunk');
  } else {
    try { json = JSON.parse(textOf(bytes)); }
    catch (_) { throw new Error('不是有效的 glTF JSON'); }
  }
  if (!json.asset || !/^2\./.test(String(json.asset.version || ''))) {
    throw new Error('只支持 glTF 2.0');
  }
  const required = json.extensionsRequired || [];
  const texBad = required.find((x) => /^KHR_texture_/.test(x));
  if (texBad) throw new Error(`这个 glTF 用了 ${texBad} 纹理压缩，本站解不开`);
  const mb = new MeshBuilder(ext, ext === 'glb' ? 'glTF 2.0 (GLB 二进制)' : 'glTF 2.0 (JSON)');
  const ignored = required.filter((x) => x !== 'KHR_draco_mesh_compression' && x !== 'EXT_meshopt_compression');
  if (ignored.length) mb.warn(`忽略 glTF 扩展：${ignored.join(' / ')}`);
  if ((json.images || []).length || (json.textures || []).length) mb.warn('贴图不还原，材质只按基色着色');

  // buffers：GLB 的 BIN chunk 给第 0 个无 uri 的 buffer，其它按 data URI / 相对路径读
  const buffers = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const b = json.buffers[i];
    if (!b.uri) {
      if (i === 0 && bin) { buffers.push(bin); continue; }
      throw new Error('glTF 的 buffer 没有 uri，也没有内嵌二进制');
    }
    if (/^data:/i.test(b.uri)) {
      const d = dataUriBytes(b.uri);
      if (!d) throw new Error('glTF 内嵌 buffer 的 data URI 解不开');
      buffers.push(d);
    } else {
      const d = await resolveUri(b.uri);
      if (!d) throw new Error(`glTF 引用的外部文件读不到：${b.uri}`);
      buffers.push(d);
    }
  }
  const meshoptViews = await decodeMeshoptViews(json, buffers);
  const accCache = new Map();
  const acc = (i) => {
    if (!accCache.has(i)) accCache.set(i, readAccessor(json, buffers, i, meshoptViews));
    return accCache.get(i);
  };
  const bvBytes = (i) => {
    const bv = (json.bufferViews || [])[i];
    if (!bv) throw new Error('glTF 的 bufferView 序号越界');
    const decoded = meshoptViews.get(i);
    if (decoded) return decoded;
    const b = buffers[bv.buffer || 0];
    if (!b) throw new Error('glTF 的 bufferView 指向的缓冲区读不到');
    const off = bv.byteOffset || 0, len = bv.byteLength === undefined ? b.length - off : bv.byteLength;
    if (off < 0 || len < 0 || off + len > b.length) throw new Error('glTF 的 bufferView 被截断');
    return b.subarray(off, off + len);
  };

  const nodes = json.nodes || [];
  const parentIdx = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    for (const ch of nodes[i].children || []) if (ch >= 0 && ch < nodes.length) parentIdx[ch] = i;
  }
  const hasSkin = (json.skins || []).length > 0;
  const animations = json.animations || [];
  const collect = hasSkin || animations.length > 0;
  // 静止姿态下每个节点的世界矩阵（节点表不一定是拓扑序，用递归 + 记忆）
  const restLocal = nodes.map((n) => nodeMatrix(n));
  const restWorld = new Array(nodes.length);
  const restVisit = (i) => {
    if (restWorld[i]) return restWorld[i];
    const p = parentIdx[i];
    restWorld[i] = matMul(p >= 0 ? restVisit(p) : IDENT(), restLocal[i]);
    return restWorld[i];
  };
  for (let i = 0; i < nodes.length; i++) restVisit(i);
  const cpPos = [], cpNode = [], triCp = [], skins = new Map();
  let dracoVertexCount = 0;

  const emitMesh = async (meshIdx, world, nodeIdx) => {
    const mesh = (json.meshes || [])[meshIdx];
    if (!mesh) return;
    for (const p of mesh.primitives || []) {
      const draco = p.extensions && p.extensions.KHR_draco_mesh_compression;
      const mode = draco ? 4 : (p.mode === undefined ? 4 : p.mode);
      if (mode !== 4 && mode !== 5 && mode !== 6) { mb.warn('跳过点 / 线等非三角形 primitive'); continue; }
      let P, N = null, C = null, idx, joints = null, weights = null;
      if (draco) {
        const d = await decodeDracoPrimitive(bvBytes(draco.bufferView), draco.attributes || {});
        P = d.attrs.POSITION; N = d.attrs.NORMAL || null; C = d.attrs.COLOR_0 || null;
        idx = d.indices;
        dracoVertexCount += P ? P.count : 0;
        mb.warn('已用 Draco 解码压缩网格');
      } else {
        if (!p.attributes || p.attributes.POSITION === undefined) continue;
        P = acc(p.attributes.POSITION);
        if (p.attributes.NORMAL !== undefined) N = acc(p.attributes.NORMAL);
        if (p.attributes.COLOR_0 !== undefined) C = acc(p.attributes.COLOR_0);
        if (p.indices === undefined) {
          idx = new Array(P.count);
          for (let i = 0; i < P.count; i++) idx[i] = i;
        } else idx = Array.from(acc(p.indices).data);
        if (collect && hasSkin && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) {
          joints = acc(p.attributes.JOINTS_0); weights = acc(p.attributes.WEIGHTS_0);
        }
      }
      if (!P || P.num < 3 || !P.count) continue;
      const list = triangleList(idx, P.count, mode);
      const base = materialColor(json, p.material);
      // TEXCOORD_0 / _1 / _2… 各算一套 UV 通道，按通道号排序，别让下标跟着 JSON 里的键顺序乱跳。
      // glTF 的 TEXCOORD 本来就是原点左上，不用翻 v。Draco 压缩的属性表另有一套名字，本轮不走这里。
      const UV = [];
      if (!draco && p.attributes) {
        for (const k of Object.keys(p.attributes).filter((x) => /^TEXCOORD_\d+$/.test(x))
          .sort((x, y) => Number(x.slice(9)) - Number(y.slice(9)))) {
          try {
            const ac = acc(p.attributes[k]);
            if (ac && ac.num >= 2 && ac.count) UV.push({ name: k.replace('TEXCOORD_', 'UV'), ac });
          } catch (_) { /* 这个 accessor 读不出来就跳过去，别把整个网格带崩 */ }
        }
      }

      // 有动画 / 蒙皮时额外留一份「模型空间控制点」，播放时由 applyModelAnimation 重算
      let cpBase = -1, skinInfo = null, restPoint = null;
      if (collect) {
        cpBase = cpPos.length / 3;
        for (let i = 0; i < P.count; i++) {
          cpPos.push(P.data[i * P.num], P.data[i * P.num + 1], P.data[i * P.num + 2]);
          cpNode.push(nodeIdx);
        }
        const sk = nodes[nodeIdx] && nodes[nodeIdx].skin !== undefined ? (json.skins || [])[nodes[nodeIdx].skin] : null;
        if (joints && weights && sk && (sk.joints || []).length) {
          const ibm = sk.inverseBindMatrices === undefined ? null : acc(sk.inverseBindMatrices);
          const bones = sk.joints;
          const cpW = new Float32Array(P.count * 4), cpBone = new Uint16Array(P.count * 4);
          for (let i = 0; i < P.count; i++) for (let s = 0; s < 4; s++) {
            cpW[i * 4 + s] = weights.data[i * weights.num + s] || 0;
            const j = Math.round(joints.data[i * joints.num + s] || 0);
            cpBone[i * 4 + s] = Math.max(0, Math.min(bones.length - 1, j));
          }
          const adjs = bones.map((_, b) => ibm && ibm.num === 16 && (b + 1) * 16 <= ibm.data.length
            ? Array.from(ibm.data.subarray(b * 16, b * 16 + 16)) : IDENT());
          skinInfo = { cpOff: cpBase, cpCount: P.count, cpW, cpBone, bones, adjs };
          skins.set(skins.size, skinInfo);
          // 静止姿态也要蒙皮：调色板 = 关节世界矩阵 × 绑定逆矩阵，结果已是世界坐标
          const palette = adjs.map((adj, b) => matMul(restWorld[bones[b]] || IDENT(), adj));
          restPoint = new Float32Array(P.count * 3);
          for (let i = 0; i < P.count; i++) {
            const x = P.data[i * P.num], y = P.data[i * P.num + 1], z = P.data[i * P.num + 2];
            let px = 0, py = 0, pz = 0;
            for (let s = 0; s < 4; s++) {
              const w = cpW[i * 4 + s];
              if (!w) continue;
              const m = palette[cpBone[i * 4 + s]];
              if (!m) continue;
              px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
              py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
              pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
            }
            restPoint[i * 3] = px; restPoint[i * 3 + 1] = py; restPoint[i * 3 + 2] = pz;
          }
        }
      }
      const pointAt = (i) => restPoint
        ? [restPoint[i * 3], restPoint[i * 3 + 1], restPoint[i * 3 + 2]]
        : applyMat(world, [P.data[i * P.num], P.data[i * P.num + 1], P.data[i * P.num + 2]]);

      for (let k = 0; k + 2 < list.length; k += 3) {
        const i0 = list[k], i1 = list[k + 1], i2 = list[k + 2];
        if (i0 >= P.count || i1 >= P.count || i2 >= P.count) continue;
        const a = pointAt(i0), b = pointAt(i1), c = pointAt(i2);
        let corners = null;
        if (N) {
          const pn = N.data;
          const q = [i0, i1, i2].map((i) => [pn[i * N.num], pn[i * N.num + 1], pn[i * N.num + 2]]);
          corners = q.map(n => transformNormal(world,n));
        }
        let col = base;
        if (C) {
          const cd = C.data, cn = C.num;
          const q = [i0, i1, i2].map((i) => [cd[i * cn], cd[i * cn + 1], cd[i * cn + 2]]);
          // COLOR_0 无论 float 还是 normalized 整数，语义都是 0~1 的线性颜色
          col = [(q[0][0] + q[1][0] + q[2][0]) / 3 * 255,
            (q[0][1] + q[1][1] + q[2][1]) / 3 * 255,
            (q[0][2] + q[1][2] + q[2][2]) / 3 * 255];
        }
        const uvs = UV.map(({ ac }) => {
          const at = (i) => i >= 0 && i < ac.count
            ? [ac.data[i * ac.num] || 0, ac.data[i * ac.num + 1] || 0] : [0, 0];
          const q0 = at(i0), q1 = at(i1), q2 = at(i2);
          return [q0[0], q0[1], q1[0], q1[1], q2[0], q2[1]];
        });
        const ok = mb.addTri(a, b, c, col, uvs, corners);
        if (ok) {
          // 第一个真正画出面的网格节点决定模型枢轴：节点世界矩阵把局部 (0,0,0)
          // 搬到哪，模型自己的原点就在哪（物体位置没归零时 ≠ 文件世界原点）。
          mb.setOriginFromMatrix(world);   // glTF 无格式级全局变换，base 按单位阵
          if (collect) triCp.push(cpBase + i0, cpBase + i1, cpBase + i2);
        }
      }
    }
  };

  const scene = (json.scenes || [])[json.scene || 0];
  const roots = scene && scene.nodes && scene.nodes.length ? scene.nodes : nodes.map((_, i) => i);
  const seen = new Set();
  const walk = async (i, parent) => {
    if (i === undefined || i >= nodes.length || seen.has(i)) return;
    seen.add(i);
    const n = nodes[i] || {};
    const m = matMul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) await emitMesh(n.mesh, m, i);
    for (const ch of n.children || []) await walk(ch, m);
  };
  for (const r of roots) await walk(r, IDENT());
  // 顶点数按实际用到的 POSITION accessor 累计
  let vc = 0;
  for (const mesh of json.meshes || []) {
    for (const p of mesh.primitives || []) {
      // Draco 的 POSITION accessor 只是元数据，没有对应的真实顶点数据
      if (p.extensions && p.extensions.KHR_draco_mesh_compression) continue;
      if (p.attributes && p.attributes.POSITION !== undefined) {
        try { vc += acc(p.attributes.POSITION).count; } catch (_) { /* 报错在 emitMesh 里给 */ }
      }
    }
  }
  mb.vertices = vc + dracoVertexCount || mb.pos.length / 3;
  const jointIds = new Set();
  for (const skin of json.skins || []) {
    for (const joint of skin.joints || []) if (Number.isInteger(joint) && nodes[joint]) jointIds.add(joint);
  }
  mb.boneCount = jointIds.size;
  const model = mb.finish();

  const takes = collect ? buildGltfTakes(json, acc, animations) : [];
  if (takes.length && triCp.length === model.triangles * 3) {
    const fps = 30;
    model.anim = {
      kind: 'gltf', ticks: 1, take: 0, takes, fps,
      name: takes[0].name, start: 0, stop: takes[0].stop,
      duration: takes[0].stop,
      frames: Math.max(1, Math.round(takes[0].stop * fps)),
      base: IDENT(),
      nodes: nodes.map((n, i) => ({
        parentIdx: parentIdx[i],
        matrix: n.matrix ? n.matrix.slice(0, 16) : null,
        t: (n.translation || [0, 0, 0]).slice(),
        r: (n.rotation || [0, 0, 0, 1]).slice(),
        s: (n.scale || [1, 1, 1]).slice(),
      })),
      curves: 0,
      cpPos: Float32Array.from(cpPos),
      cpNode: Uint32Array.from(cpNode),
      triCp: Uint32Array.from(triCp),
      skins: skins.size ? skins : null,
      morphs: null,
    };
  }
  if ((json.meshes || []).some((m) => (m.primitives || []).some((p) => (p.targets || []).length))) {
    mb.warn('glTF 形态键（morph targets）不还原，只显示静止姿态');
  }
  return model;
}

// glTF 动画采样：把每条 channel 整理成 { path, times, values, inter, frames, num }，
// 按目标节点分桶，多个 animation 就是多个 Take，与 FBX 的工具条共用一套接口。
function buildGltfTakes(json, acc, animations) {
  const takes = [];
  for (let i = 0; i < animations.length; i++) {
    const an = animations[i] || {};
    const byNode = new Map();
    let stop = 0, count = 0;
    for (const ch of an.channels || []) {
      if (!ch.target || ch.target.node === undefined) continue;
      const path = ch.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue;
      const sm = (an.samplers || [])[ch.sampler];
      if (!sm) continue;
      let T, V;
      try { T = acc(sm.input); V = acc(sm.output); } catch (_) { continue; }
      if (!T || !V || T.num !== 1 || !T.count || !V.count) continue;
      const inter = sm.interpolation || 'LINEAR';
      const frames = T.count;
      if (V.count < frames * (inter === 'CUBICSPLINE' ? 3 : 1)) continue;
      const tr = { path, inter, frames, num: V.num, times: T.data, values: V.data };
      if (!byNode.has(ch.target.node)) byNode.set(ch.target.node, []);
      byNode.get(ch.target.node).push(tr);
      stop = Math.max(stop, T.data[frames - 1] || 0);
      count++;
    }
    if (!count) continue;
    takes.push({ name: an.name || `动画 ${i + 1}`, start: 0, stop,
      duration: stop, frames: Math.max(1, Math.round(stop * 30)),
      nodeCurves: count, byNode });
  }
  return takes;
}

function gltfChannelValues(tr, frame, slot) {
  const stride = tr.inter === 'CUBICSPLINE' ? tr.num * 3 : tr.num;
  const off = frame * stride + (tr.inter === 'CUBICSPLINE' ? slot * tr.num : 0);
  return Array.from(tr.values.subarray(off, off + tr.num));
}

function quatSlerp(a, b, u) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) { bb = b.map((v) => -v); dot = -dot; }
  if (dot > 0.9995) {
    const r = a.map((v, k) => v + (bb[k] - v) * u);
    const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return r.map((v) => v / l);
  }
  const th = Math.acos(Math.min(1, dot)), s = Math.sin(th);
  const w1 = Math.sin((1 - u) * th) / s, w2 = Math.sin(u * th) / s;
  return [a[0] * w1 + bb[0] * w2, a[1] * w1 + bb[1] * w2,
    a[2] * w1 + bb[2] * w2, a[3] * w1 + bb[3] * w2];
}

function sampleGltfChannel(tr, t) {
  const { times, frames } = tr;
  let i = 0;
  while (i + 1 < frames && times[i + 1] < t) i++;
  const j = Math.min(i + 1, frames - 1);
  if (tr.inter === 'STEP' || i === j || times[j] <= times[i]) return gltfChannelValues(tr, i, 1);
  const span = times[j] - times[i];
  const u = Math.max(0, Math.min(1, (t - times[i]) / span));
  if (tr.inter === 'CUBICSPLINE') {
    const v0 = gltfChannelValues(tr, i, 1), v1 = gltfChannelValues(tr, j, 1);
    const o0 = gltfChannelValues(tr, i, 2), i1 = gltfChannelValues(tr, j, 0);
    const u2 = u * u, u3 = u2 * u;
    return v0.map((v, k) => (2 * u3 - 3 * u2 + 1) * v + (u3 - 2 * u2 + u) * o0[k] * span
      + (-2 * u3 + 3 * u2) * v1[k] + (u3 - u2) * i1[k] * span);
  }
  const a = gltfChannelValues(tr, i, 1), b = gltfChannelValues(tr, j, 1);
  if (tr.path === 'rotation') return quatSlerp(a, b, u);
  return a.map((v, k) => v + (b[k] - v) * u);
}

// 按当前 Take 在 seconds 时刻求出每个节点的世界矩阵（列主序），再交给 poseFromWorld
function gltfWorld(a, tk, seconds) {
  const t = Math.max(0, seconds);
  const nodes = a.nodes, local = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.matrix) { local[i] = n.matrix; continue; }
    let tr = n.t.slice(), rt = n.r.slice(), sc = n.s.slice();
    const cs = tk.byNode && tk.byNode.get(i);
    if (cs) for (const c of cs) {
      const v = sampleGltfChannel(c, t);
      if (c.path === 'translation') tr = v.slice(0, 3);
      else if (c.path === 'rotation') rt = v.slice(0, 4);
      else if (c.path === 'scale') sc = v.slice(0, 3);
    }
    const l = Math.hypot(rt[0], rt[1], rt[2], rt[3]) || 1;
    local[i] = nodeMatrix({ translation: tr, rotation: rt.map((x) => x / l), scale: sc });
  }
  const world = new Array(nodes.length);
  const visit = (i) => {
    if (world[i]) return world[i];
    const p = nodes[i].parentIdx;
    const parent = p >= 0 && p < nodes.length ? visit(p) : a.base;
    world[i] = matMul(parent, local[i]);
    return world[i];
  };
  for (let i = 0; i < nodes.length; i++) visit(i);
  return world;
}

// ---------------- PLY ----------------
// Stanford PLY：一个 ASCII 头 + 三种数据体（ascii / binary LE / binary BE）。
// element 是表、property 是列，face 的顶点索引用 `property list` 变长存；
// 多边形按扇形三角化，因为本站只画三角形。点云（只有 vertex 没有 face）明确拒绝。

const PLY_SCALAR = {
  char: 'i1', int8: 'i1', uchar: 'u1', uint8: 'u1',
  short: 'i2', int16: 'i2', ushort: 'u2', uint16: 'u2',
  int: 'i4', int32: 'i4', uint: 'u4', uint32: 'u4',
  float: 'f4', float32: 'f4', double: 'f8', float64: 'f8',
};

function plyScalarReader(bytes, off, little) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = off;
  return (tag) => {
    let v;
    switch (tag) {
      case 'i1': v = dv.getInt8(p); p += 1; break;
      case 'u1': v = dv.getUint8(p); p += 1; break;
      case 'i2': v = dv.getInt16(p, little); p += 2; break;
      case 'u2': v = dv.getUint16(p, little); p += 2; break;
      case 'i4': v = dv.getInt32(p, little); p += 4; break;
      case 'u4': v = dv.getUint32(p, little); p += 4; break;
      case 'f4': v = dv.getFloat32(p, little); p += 4; break;
      default: v = dv.getFloat64(p, little); p += 8; break;
    }
    return v;
  };
}

function parsePly(bytes) {
  const head = textOf(bytes.subarray(0, Math.min(bytes.length, 65536)));
  if (!/^ply\s*(\r?\n|$)/.test(head)) throw new Error('不是有效的 PLY 文件（缺 ply 头）');
  const eh = head.indexOf('end_header');
  if (eh < 0) throw new Error('PLY 缺 end_header');
  let dataStart = eh + 'end_header'.length;
  if (head[dataStart] === '\r') dataStart++;
  if (head[dataStart] === '\n') dataStart++;

  let format = 'ascii', little = true;
  const elements = [];
  for (const raw of head.slice(0, eh).split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t === 'ply' || t.startsWith('comment')) continue;
    const w = t.split(/\s+/);
    if (w[0] === 'format') {
      format = w[1];
      little = format !== 'binary_big_endian';
      if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
        throw new Error(`PLY 不认识的数据格式：${format}`);
      }
      if (w[2] !== '1.0') throw new Error(`PLY 只支持 1.0，遇到 ${w[2] || '?'} `);
    } else if (w[0] === 'element') {
      elements.push({ name: w[1], count: Math.max(0, parseInt(w[2], 10) || 0), props: [] });
    } else if (w[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('PLY 的 property 出现在 element 之前');
      if (w[1] === 'list') {
        const ct = PLY_SCALAR[w[2]], it = PLY_SCALAR[w[3]];
        if (!ct || !it) throw new Error(`PLY 不认识的 list 类型：${w[2]} ${w[3]}`);
        el.props.push({ name: w[4], list: true, countTag: ct, itemTag: it });
      } else {
        const tag = PLY_SCALAR[w[1]];
        if (!tag) throw new Error(`PLY 不认识的属性类型：${w[1]}`);
        el.props.push({ name: w[2], list: false, tag });
      }
    }
  }

  const tables = {};
  if (format === 'ascii') {
    const rows = textOf(bytes.subarray(dataStart)).split(/\r?\n/).filter((l) => l.trim());
    let li = 0;
    for (const el of elements) {
      const out = [];
      for (let i = 0; i < el.count; i++) {
        const line = rows[li++];
        if (line === undefined) throw new Error(`PLY 数据提前结束（${el.name} 缺行）`);
        const tok = line.trim().split(/\s+/);
        let ti = 0;
        const row = [];
        for (const p of el.props) {
          if (p.list) {
            const n = parseInt(tok[ti++], 10);
            if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('PLY 面索引数量异常');
            const arr = [];
            for (let k = 0; k < n; k++) arr.push(parseFloat(tok[ti++]));
            row.push(arr);
          } else row.push(parseFloat(tok[ti++]));
        }
        out.push(row);
      }
      tables[el.name] = out;
    }
  } else {
    const rd = plyScalarReader(bytes, dataStart, little);
    for (const el of elements) {
      const out = [];
      for (let i = 0; i < el.count; i++) {
        const row = [];
        for (const p of el.props) {
          if (p.list) {
            const n = rd(p.countTag);
            if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('PLY 面索引数量异常');
            const arr = [];
            for (let k = 0; k < n; k++) arr.push(rd(p.itemTag));
            row.push(arr);
          } else row.push(rd(p.tag));
        }
        out.push(row);
      }
      tables[el.name] = out;
    }
  }

  const vEl = elements.find((e) => e.name === 'vertex');
  const fEl = elements.find((e) => e.name === 'face');
  if (!vEl || !fEl) {
    throw new Error('PLY 点云 / 没有 face 元素：本站只预览三角网格');
  }
  const colOf = (el, names) => names.map((n) => el.props.findIndex((p) => p.name === n));
  const xi = vEl.props.findIndex((p) => p.name === 'x');
  const yi = vEl.props.findIndex((p) => p.name === 'y');
  const zi = vEl.props.findIndex((p) => p.name === 'z');
  if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY 顶点缺 x / y / z');
  const ci = colOf(vEl, ['red', 'green', 'blue']);
  const ai = colOf(vEl, ['r', 'g', 'b']);
  const cidx = ci.every((i) => i >= 0) ? ci : (ai.every((i) => i >= 0) ? ai : null);
  const ni = colOf(vEl, ['nx', 'ny', 'nz']);
  const nidx = ni.every((i) => i >= 0) ? ni : null;

  // 顶点色可能是 uchar 0..255，也可能是 float 0..1，按全表最大值判一次
  let cmax = 0;
  if (cidx) for (const row of tables.vertex || []) for (const i of cidx) cmax = Math.max(cmax, row[i] || 0);
  const cscale = cmax <= 1.001 ? 255 : 1;
  const vrows = tables.vertex || [];
  const vs = vrows.map((row) => [
    row[xi], row[yi], row[zi],
    ...(cidx ? cidx.map((i) => (row[i] || 0) * cscale) : [176, 186, 202]),
    ...(nidx ? nidx.map((i) => row[i] || 0) : []),
  ]);

  const fList = fEl.props.findIndex((p) => p.list && /vertex|index/i.test(p.name));
  if (fList < 0) throw new Error('PLY 的 face 缺顶点索引列表');
  const fc = colOf(fEl, ['red', 'green', 'blue']);
  const fidx = fc.every((i) => i >= 0) ? fc : null;
  let fmax = 0;
  if (fidx) for (const row of tables.face || []) for (const i of fidx) fmax = Math.max(fmax, row[i] || 0);
  const fscale = fmax <= 1.001 ? 255 : 1;

  const mb = new MeshBuilder('ply',
    `PLY ${format === 'ascii' ? 'ASCII' : (little ? '二进制 LE' : '二进制 BE')} 三角网格`);
  for (const row of tables.face || []) {
    const idx = row[fList];
    if (!Array.isArray(idx) || idx.length < 3) continue;
    const faceCol = fidx ? fidx.map((i) => (row[i] || 0) * fscale) : null;
    for (let k = 1; k < idx.length - 1; k++) {
      const a = vs[idx[0]], b = vs[idx[k]], c = vs[idx[k + 1]];
      if (!a || !b || !c) { mb.warn('PLY 面里有越界的顶点索引'); continue; }
      const color = faceCol || [0, 1, 2].map((j) => (a[3 + j] + b[3 + j] + c[3 + j]) / 3);
      mb.addTri(a, b, c, color, null, nidx ? [a,b,c].map(v=>v.slice(6,9)) : null);
    }
  }
  mb.vertices = vs.length;
  if (fEl.props.some((p) => /strip/i.test(p.name))) mb.warn('PLY triangle strip 按普通面表处理');
  return mb.finish();
}

// ---------------- 3MF ----------------
// 3D Manufacturing Format：OPC(ZIP) 包 + 一份 3D/3dmodel.model XML。
// 只吃 Core 子集：mesh 的顶点 / 三角面、build item 的 3x4 变换、components 复用、
// colorgroup / basematerials 的颜色组。声明了 RequiredExtensions 就明确拒绝，
// 免得把切片 / Beam Lattice / 材质扩展的模型静默画成半个。

const XML_LOCAL = (n) => (n && (n.localName || n.nodeName.replace(/^.*:/, ''))) || '';
function xmlKids(el, name) {
  const out = [];
  for (let c = el && el.firstElementChild; c; c = c.nextElementSibling) {
    if (!name || XML_LOCAL(c).toLowerCase() === name.toLowerCase()) out.push(c);
  }
  return out;
}
const xmlFirst = (el, name) => xmlKids(el, name)[0] || null;

function hexColor(s) {
  if (!s) return null;
  const m = /^\s*#?([0-9a-f]{6})([0-9a-f]{2})?\s*$/i.exec(s);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

async function parse3mf(bytes) {
  const zip = openZip(bytes);
  if (!zip) throw new Error('3MF 不是有效的 ZIP / OPC 容器');
  let entry = findZipEntry(zip, '3D/3dmodel.model');
  if (!entry) {
    const rels = findZipEntry(zip, '_rels/.rels');
    if (rels) {
      const rb = await readZipEntry(zip, rels);
      if (rb) {
        const rd = new DOMParser().parseFromString(textOf(rb), 'application/xml');
        const rel = xmlKids(rd, 'Relationship').find((n) =>
          /3dmodel|model/i.test((n.getAttribute('Type') || '') + (n.getAttribute('Target') || '')));
        if (rel) entry = findZipEntry(zip, (rel.getAttribute('Target') || '').replace(/^\/+/, ''));
      }
    }
  }
  if (!entry) entry = zip.entries.find((e) => /\.model$/i.test(e.name)) || null;
  if (!entry) throw new Error('3MF 里找不到 3D/3dmodel.model');
  const xb = await readZipEntry(zip, entry);
  if (!xb) throw new Error('3MF 模型条目读不出来（加密或压缩方式不支持）');
  const doc = new DOMParser().parseFromString(textOf(xb), 'application/xml');
  if (!doc || doc.getElementsByTagName('parsererror').length) throw new Error('3MF 模型 XML 解析失败');
  const root = xmlFirst(doc, 'model');
  if (!root) throw new Error('3MF 缺 <model> 根元素');

  const req = root.getAttribute('requiredextensions') || root.getAttribute('RequiredExtensions') || '';
  if (req.trim()) throw new Error(`3MF 用了本站不支持的必需扩展：${req.trim()}`);

  const UNIT = { millimeter: 1, micron: 0.001, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };
  const unit = UNIT[(root.getAttribute('unit') || 'millimeter').toLowerCase()] ?? 1;
  const mb = new MeshBuilder('3mf', '3MF 三维制造模型');
  const resources = xmlFirst(root, 'resources');
  const build = xmlFirst(root, 'build');
  const objects = new Map();
  for (const o of xmlKids(resources, 'object')) objects.set(o.getAttribute('id'), o);
  const groups = new Map();
  for (const g of [...xmlKids(resources, 'colorgroup'), ...xmlKids(resources, 'basematerials')]) {
    const cols = [];
    for (const c of xmlKids(g, 'color')) cols.push(hexColor(c.getAttribute('color')));
    for (const c of xmlKids(g, 'base')) cols.push(hexColor(c.getAttribute('displaycolor')));
    groups.set(g.getAttribute('id'), cols);
  }
  const transform = (s) => {
    if (!s) return IDENT();
    const a = s.trim().split(/[\s,]+/).map(Number);
    if (a.length !== 12 || a.some((v) => !Number.isFinite(v))) return IDENT();
    // 3MF 是行主序 3x4：x' = m00*x + m01*y + m02*z + m30
    return [a[0], a[3], a[6], 0, a[1], a[4], a[7], 0, a[2], a[5], a[8], 0, a[9], a[10], a[11], 1];
  };
  const propColor = (pid, idx) => {
    if (!pid || idx === undefined || idx === null || idx === '') return null;
    const g = groups.get(pid);
    return (g && g[Number(idx)]) || null;
  };

  function emitMesh(o, mesh, mat) {
    const vsEl = xmlFirst(mesh, 'vertices');
    const trEl = xmlFirst(mesh, 'triangles');
    if (!vsEl || !trEl) return;
    const vs = xmlKids(vsEl, 'vertex').map((v) => applyMat(mat, [
      (parseFloat(v.getAttribute('x')) || 0) * unit,
      (parseFloat(v.getAttribute('y')) || 0) * unit,
      (parseFloat(v.getAttribute('z')) || 0) * unit,
    ]));
    const defPid = o.getAttribute('pid'), defP1 = o.getAttribute('p1');
    for (const t of xmlKids(trEl, 'triangle')) {
      const a = vs[Number(t.getAttribute('v1'))];
      const b = vs[Number(t.getAttribute('v2'))];
      const c = vs[Number(t.getAttribute('v3'))];
      if (!a || !b || !c) { mb.warn('3MF 三角形引用了越界顶点'); continue; }
      const pid = t.getAttribute('pid') || defPid;
      const p1 = t.getAttribute('p1') || defP1;
      const cols = [p1, t.getAttribute('p2'), t.getAttribute('p3')].map((p) => propColor(pid, p)).filter(Boolean);
      let color = null;
      if (cols.length) {
        color = [0, 1, 2].map((j) => cols.reduce((s, v) => s + v[j], 0) / cols.length);
        mb.materials.add(`${pid}`);
      }
      if (mb.addTri(a, b, c, color)) mb.setOriginFromMatrix(mat);   // 3MF 只有组件变换链，无全局 base
    }
    mb.vertices += vs.length;
  }

  function emitObject(id, mat, depth) {
    if (depth > 16) { mb.warn('3MF 组件嵌套过深，已截断'); return; }
    const o = objects.get(id);
    if (!o) { mb.warn(`3MF 引用了不存在的对象 ${id}`); return; }
    const mesh = xmlFirst(o, 'mesh');
    if (mesh) emitMesh(o, mesh, mat);
    const comps = xmlFirst(o, 'components');
    if (comps) for (const c of xmlKids(comps, 'component')) {
      emitObject(c.getAttribute('objectid'), matMul(mat, transform(c.getAttribute('transform'))), depth + 1);
    }
  }

  for (const item of xmlKids(build, 'item')) {
    emitObject(item.getAttribute('objectid'), transform(item.getAttribute('transform')), 0);
  }
  if (!mb.pos.length) {
    // 没有 <build>（有些切片器直接给 resources）就画第一个 mesh
    for (const o of objects.values()) if (xmlFirst(o, 'mesh')) emitObject(o.getAttribute('id'), IDENT(), 0);
  }
  if (unit !== 1) mb.warn(`3MF 单位 ${root.getAttribute('unit')}，坐标已换算到毫米`);
  return mb.finish();
}

// ---------------- FBX ----------------
// 两套壳子统一解成 { name, props, children } 节点树：
//   - 二进制：23 字节魔数 + u32 版本，之后是平铺的 NodeRecord（7500+ 用 64 位偏移）；
//   - ASCII：`Name: v1, v2 { ... }`，数组写成 `Name: *N { a: ... }`。
// 属性类型 Y/C/I/F/D/L/S/R + f/d/l/i/b 数组（encoding=1 是 zlib）。
// 几何取 Geometry 的 Vertices / PolygonVertexIndex，变换取 Model 的 Lcl / PreRotation，
// 层级与几何归属取 Connections。动画取 AnimationCurve 的 KeyTime / KeyValueFloat。

const FBX_TICKS = 46186158000;   // FBX KTime：一秒的 tick 数

async function inflateZlib(src) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前环境不支持 zlib 解压（FBX 压缩数组）');
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

async function fbxParseBinary(bytes) {
  if (!/^Kaydara FBX Binary/.test(textOf(bytes.subarray(0, 20)))) {
    throw new Error('不是 FBX 二进制文件（缺 Kaydara 魔数）');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 27) throw new Error('FBX 文件太短');
  const version = dv.getUint32(23, true);
  if (version < 7000 || version > 8000) throw new Error(`FBX 版本 ${version} 不在 7000~8000 支持范围`);
  const w64 = version >= 7500;
  const HS = w64 ? 25 : 13;
  let p = 27;
  const num = (o) => (w64 ? Number(dv.getBigUint64(o, true)) : dv.getUint32(o, true));

  async function readProp() {
    if (p >= bytes.length) throw new Error('FBX 属性数据越界');
    const t = String.fromCharCode(bytes[p++]);
    switch (t) {
      case 'Y': { const v = dv.getInt16(p, true); p += 2; return v; }
      case 'C': { const v = !!bytes[p]; p += 1; return v; }
      case 'I': { const v = dv.getInt32(p, true); p += 4; return v; }
      case 'F': { const v = dv.getFloat32(p, true); p += 4; return v; }
      case 'D': { const v = dv.getFloat64(p, true); p += 8; return v; }
      case 'L': { const v = Number(dv.getBigInt64(p, true)); p += 8; return v; }
      case 'S': {
        const n = dv.getUint32(p, true); p += 4;
        const v = textOf(bytes.subarray(p, p + n)); p += n; return v;
      }
      case 'R': {
        const n = dv.getUint32(p, true); p += 4;
        const v = bytes.slice(p, p + n); p += n; return v;
      }
      default: {
        if (!'fdlib'.includes(t) || t.length !== 1) throw new Error(`FBX 不认识的属性类型 ${t}`);
        const n = dv.getUint32(p, true), enc = dv.getUint32(p + 4, true), clen = dv.getUint32(p + 8, true);
        p += 12;
        let raw = bytes.subarray(p, p + clen); p += clen;
        if (enc === 1) raw = await inflateZlib(raw);
        else if (enc !== 0) throw new Error('FBX 数组压缩方式不支持');
        const ad = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const sz = { f: 4, d: 8, l: 8, i: 4, b: 1 }[t];
        const count = Math.min(n, Math.floor(raw.length / sz));
        const out = new Array(count);
        for (let k = 0; k < count; k++) {
          const o = k * sz;
          out[k] = t === 'f' ? ad.getFloat32(o, true) : t === 'd' ? ad.getFloat64(o, true)
            : t === 'l' ? Number(ad.getBigInt64(o, true)) : t === 'i' ? ad.getInt32(o, true) : raw[o];
        }
        return out;
      }
    }
  }

  async function readNode() {
    const start = p;
    if (start + HS > bytes.length) return null;
    const endOff = num(start);
    const nProps = num(start + (w64 ? 8 : 4));
    const propLen = num(start + (w64 ? 16 : 8));
    const nameLen = bytes[start + HS - 1];
    if (!(endOff >= start + HS && endOff <= bytes.length)) return null;
    const name = textOf(bytes.subarray(start + HS, start + HS + nameLen));
    p = start + HS + nameLen;
    const propsEnd = p + propLen;
    const props = [];
    for (let i = 0; i < nProps && p < propsEnd; i++) props.push(await readProp());
    p = Math.max(p, propsEnd);
    const children = [];
    while (p + HS <= endOff) {
      const c = await readNode();
      if (!c) break;
      if (c.name) children.push(c);          // name='' 是子节点表末尾的 NULL record
      if (p >= endOff) break;
    }
    p = Math.max(p, endOff);
    return { name, props, children };
  }

  const root = { name: '', props: [], children: [] };
  while (p + HS <= bytes.length) {
    const before = p;
    const n = await readNode();
    if (!n) break;
    if (n.name) root.children.push(n);
    if (p <= before || p >= bytes.length - 4) break;   // 尾部是 footer，不再当记录读
  }
  if (!root.children.length) throw new Error('FBX 二进制里读不到节点');
  return root;
}

function fbxSplitProps(s) {
  const out = [];
  let cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((v) => {
    if (/^[+-]?\d+$/.test(v)) return parseInt(v, 10);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return parseFloat(v);
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    return v;
  });
}

function fbxParseAscii(bytes) {
  const text = textOf(bytes);
  if (!/FBXHeaderExtension|Objects\s*:/.test(text)) throw new Error('不是 FBX ASCII 文件');
  const root = { name: '', props: [], children: [] };
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    if (line.startsWith('}')) {
      const n = stack[stack.length - 1];
      if (n && n._array) {
        const arr = [];
        for (const c of n.children) if (c.name === 'a') arr.push(...c.props.map((v) => Number(v)));
        n.props = [arr.filter((v) => Number.isFinite(v))];
        n.children = [];
        delete n._array;
      }
      if (stack.length > 1) stack.pop();
      continue;
    }
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const name = line.slice(0, ci).trim();
    let rest = line.slice(ci + 1).trim();
    let block = false;
    if (rest.endsWith('{')) { rest = rest.slice(0, -1).trim(); block = true; }
    const props = rest ? fbxSplitProps(rest) : [];
    const node = { name, props, children: [], _array: /^\*\d+/.test(rest) };
    stack[stack.length - 1].children.push(node);
    if (block) stack.push(node);
  }
  return root;
}

const fbxKids = (n, name) => n ? n.children.filter((c) => c.name === name) : [];
const fbxFirst = (n, name) => fbxKids(n, name)[0] || null;
const fbxArray = (n) => {
  if (!n) return [];
  if (Array.isArray(n.props[0])) return n.props[0];
  return n.props.filter((v) => typeof v === 'number');
};
const fbxPropVals = (node, name) => {
  const p70 = fbxFirst(node, 'Properties70');
  for (const p of fbxKids(p70, 'P')) {
    if (String(p.props[0]) === name) return p.props.filter((v) => typeof v === 'number').slice(-3);
  }
  return null;
};

// ---- FBX 的 UV 通道 ----
// LayerElementUV 可以挂很多组（UV0 / UV1 / LightmapUV…），每组算一个通道。
// 最常见的是 ByPolygonVertex + IndexToDirect：UVIndex[pv] 里的 pv 就是
// PolygonVertexIndex 数组里的下标；Direct 直接用 pv；ByVertice 用顶点下标。
// FBX 的 v 原点在左下，统一翻成左上（和 glTF / canvas 贴图坐标一致）。
// Source normals take precedence; only explicit smoothing data permits averaging.
function fbxCornerNormals(g) {
  const vs=fbxArray(fbxFirst(g,'Vertices')), indices=fbxArray(fbxFirst(g,'PolygonVertexIndex'));
  const faces=[], pvFaces=[]; let poly=[];
  indices.forEach((v,pv)=>{pvFaces[pv]=faces.length;poly.push(v<0?-v-1:v);if(v<0){faces.push(poly);poly=[];}});
  const L=fbxFirst(g,'LayerElementNormal');
  const mapping=L=>String(fbxFirst(L,'MappingInformationType')?.props[0]||'');
  const read=(L,values,indexes,k,pv,face)=>{
    const map=mapping(L);let at=map==='ByPolygonVertex'?pv:/^ByVert/.test(map)?k:map==='ByPolygon'?face:map==='AllSame'?0:-1;
    const ref=String(fbxFirst(L,'ReferenceInformationType')?.props[0]||'Direct');
    if(ref==='IndexToDirect'||ref==='Index')at=indexes[at];
    return at;
  };
  if(L) {
    const values=fbxArray(fbxFirst(L,'Normals')), indexes=fbxArray(fbxFirst(L,'NormalsIndex'));
    const normals=indices.map((v,pv)=>{
      const at=read(L,values,indexes,v<0?-v-1:v,pv,pvFaces[pv]);
      const n=values.slice(at*3,at*3+3);
      return at>=0 && n.length===3 && n.every(Number.isFinite) && Math.hypot(...n)>1e-12 ? n : null;
    });
    if(normals.some(Boolean))return normals;
  }
  const S=fbxFirst(g,'LayerElementSmoothing');if(!S)return [];
  const values=fbxArray(fbxFirst(S,'Smoothing')), indexes=fbxArray(fbxFirst(S,'SmoothingIndex'));
  const vertices=Array.from({length:vs.length/3},(_,i)=>vs.slice(i*3,i*3+3));
  if(mapping(S)==='ByPolygon'||mapping(S)==='AllSame') {
    const groups=faces.map((_,f)=>values[read(S,values,indexes,0,0,f)]||0);
    return groupNormals(vertices,faces,groups,true).flat();
  }
  if(mapping(S)==='ByEdge') {
    // Join corner fans across explicitly soft original polygon edges only.
    const edgeTable=fbxArray(fbxFirst(g,'Edges')), soft=new Set(), next=[];
    let start=0;
    indices.forEach((v,pv)=>{next[pv]=v<0?start:pv+1;if(v<0)start=pv+1;});
    const cp=pv=>indices[pv]<0?-indices[pv]-1:indices[pv];
    const key=pv=>[cp(pv),cp(next[pv])].sort((a,b)=>a-b).join(':');
    edgeTable.forEach((pv,i)=>{const ref=String(fbxFirst(S,'ReferenceInformationType')?.props[0]||'Direct');
      if(values[ref==='Direct'?i:indexes[i]] && next[pv]!==undefined)soft.add(key(pv));});
    const parent=indices.map((_,i)=>i), find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const edges=new Map();
    indices.forEach((_,pv)=>{const k=key(pv);if(!soft.has(k))return;
      if(!edges.has(k))edges.set(k,[]);const list=edges.get(k);
      for(const other of list)for(const a of [pv,next[pv]])for(const b of [other,next[other]])if(cp(a)===cp(b))parent[find(a)]=find(b);
      list.push(pv);
    });
    const faceNormals=groupNormals(vertices,faces,faces.map(()=>0)).map(ns=>ns[0]);
    const sums=new Map();indices.forEach((_,pv)=>{const root=find(pv);if(!sums.has(root))sums.set(root,new Set());sums.get(root).add(pvFaces[pv]);});
    return indices.map((_,pv)=>{const n=[0,0,0];for(const f of sums.get(find(pv)))for(let j=0;j<3;j++)n[j]+=faceNormals[f][j];return n;});
  }
  return [];
}

function fbxUvLayers(g) {
  return fbxKids(g, 'LayerElementUV').map((L, i) => {
    const uv = fbxArray(fbxFirst(L, 'UV'));
    const uvi = fbxArray(fbxFirst(L, 'UVIndex'));
    const str = (nm, dflt) => {
      const n = fbxFirst(L, nm);
      return n && n.props && n.props.length ? String(n.props[0]) : dflt;
    };
    const nn = fbxFirst(L, 'Name');
    const name = nn && nn.props && nn.props.length ? String(nn.props[0]) : '';
    return {
      name: name || `UV${i}`, uv, uvi,
      map: str('MappingInformationType', 'ByPolygonVertex'),
      ref: str('ReferenceInformationType', 'IndexToDirect'),
    };
  }).filter((L) => L.uv.length >= 2);
}

function fbxUvAt(layers, k, pv) {
  return layers.map((L) => {
    let idx = pv;
    if (/^ByVertice|^ByVertex/i.test(L.map)) idx = k;
    else if (L.ref === 'IndexToDirect' && L.uvi.length > pv) idx = L.uvi[pv];
    return [L.uv[idx * 2] || 0, 1 - (L.uv[idx * 2 + 1] || 0)];
  });
}

function fbxUvTri(layers, p0, p1, p2) {
  if (!layers.length) return [];
  const q = [p0, p1, p2].map((p) => fbxUvAt(layers, p.k, p.pv));
  return layers.map((_, s) => [
    q[0][s][0], q[0][s][1], q[1][s][0], q[1][s][1], q[2][s][0], q[2][s][1],
  ]);
}

function fbxTranslation(t) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0] || 0, t[1] || 0, t[2] || 0, 1];
}
function fbxScale(s) {
  return [s[0] ?? 1, 0, 0, 0, 0, s[1] ?? 1, 0, 0, 0, 0, s[2] ?? 1, 0, 0, 0, 0, 1];
}
// FBX 的 Lcl Rotation 是欧拉角（度），具体旋转顺序由 RotationOrder 决定（0=XYZ 默认）
const FBX_EULER_ORDER = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'];
function fbxEuler(r, order = 0) {
  const d = Math.PI / 180;
  const rd = [(r[0] || 0) * d, (r[1] || 0) * d, (r[2] || 0) * d];
  const seq = FBX_EULER_ORDER[order] || 'XYZ';
  let m = IDENT();
  for (const ch of seq) {
    const a = ch === 'X' ? rd[0] : ch === 'Y' ? rd[1] : rd[2];
    const c = Math.cos(a), s = Math.sin(a);
    const rm = ch === 'X' ? [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
      : ch === 'Y' ? [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
        : [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m = matMul(rm, m);
  }
  return m;
}
// 本地变换 = T * Roff * Rp * Rpre * R * Rp⁻¹ * S（枢轴 / 偏移大多数文件为 0）
function fbxLocal(t, pre, r, s, order = 0, pivot = null, offset = null) {
  let m = fbxTranslation(t);
  if (offset) m = matMul(m, fbxTranslation(offset));
  if (pivot) m = matMul(m, fbxTranslation(pivot));
  m = matMul(m, fbxEuler(pre, order));
  m = matMul(m, fbxEuler(r, order));
  if (pivot) m = matMul(m, fbxTranslation([-pivot[0], -pivot[1], -pivot[2]]));
  return matMul(m, fbxScale(s));
}

function fbxSample(c, t) {
  const { times, values } = c;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  const span = times[hi] - times[lo];
  const u = span > 0 ? (t - times[lo]) / span : 0;
  return values[lo] + (values[hi] - values[lo]) * u;
}

// 形态键（blend shape）求值。Channel 的 DeformPercent 是 0–100 的百分比：
// 单 Shape 直接按百分比缩放增量；同一 Channel 挂多个 Shape 时，FullWeights 是各 Shape
// 被完全激活的阈值，按阈值区间做 in-between 渐进插值。
function morphWeights(chan, pct) {
  const n = chan.shapes.length;
  const w = chan._w || (chan._w = new Float32Array(n));
  w.fill(0);
  if (!n) return w;
  const d = Number.isFinite(pct) ? (pct < 0 ? 0 : pct > 100 ? 100 : pct) : 0;
  if (n === 1) { w[0] = d / 100; return w; }
  const full = chan.full;
  if (d <= full[0]) { w[0] = full[0] > 0 ? d / full[0] : 1; return w; }
  for (let i = 0; i + 1 < n; i++) {
    if (d <= full[i + 1]) {
      const span = full[i + 1] - full[i];
      const t = span > 0 ? (d - full[i]) / span : 1;
      w[i] = 1 - t;
      w[i + 1] = t;
      return w;
    }
  }
  w[n - 1] = 1;
  return w;
}

// 把各形态键通道的增量叠加到 dst（cpPos 的副本）上；idx 是基础网格的控制点下标。
function applyMorphs(dst, morphs, pctOf, cpCount) {
  for (const nd of morphs) {
    for (const chan of nd.channels) {
      const w = morphWeights(chan, pctOf(chan));
      for (let s = 0; s < chan.shapes.length; s++) {
        const ws = w[s];
        if (!(ws > 0)) continue;
        const sh = chan.shapes[s];
        for (let k = 0; k < sh.idx.length; k++) {
          const q = nd.cpOff + sh.idx[k];
          if (q < 0 || q >= cpCount) continue;
          dst[q * 3] += ws * sh.d[k * 3];
          dst[q * 3 + 1] += ws * sh.d[k * 3 + 1];
          dst[q * 3 + 2] += ws * sh.d[k * 3 + 2];
        }
      }
    }
  }
}

// 动画层权重：FBX 用 0–100 的百分比，乘进混合前先归一化到 0–1
function layerWeight(w) {
  const v = Number(w);
  return !Number.isFinite(v) || v <= 0 ? 0 : v >= 100 ? 1 : v / 100;
}

// 某个 Take 在 t 时刻对形态键 Channel 的百分比：从默认 DeformPercent 出发，
// 按层顺序用各层的曲线值做线性混合（单层 weight=100 时就是曲线原值）。
function takeMorphPct(tk, chan, t) {
  let pct = chan.def;
  const cs = tk && tk.morphByChan ? tk.morphByChan.get(chan) : null;
  if (cs) {
    for (const c of cs) {
      const w = layerWeight(c.weight);
      if (w > 0) pct = pct * (1 - w) + fbxSample(c, t) * w;
    }
  }
  return pct;
}

async function parseFbx(bytes) {
  const ascii = !/^Kaydara FBX Binary/.test(textOf(bytes.subarray(0, 20)));
  const root = ascii ? fbxParseAscii(bytes) : await fbxParseBinary(bytes);
  const objects = fbxFirst(root, 'Objects');
  if (!objects) throw new Error('FBX 缺 Objects 段');
  const conns = fbxFirst(root, 'Connections');
  const gs = fbxFirst(root, 'GlobalSettings');

  let upAxis = 1, unitScale = 1, frameRate = 0, timeMode = 0;
  for (const p of fbxKids(fbxFirst(gs, 'Properties70'), 'P')) {
    const v = p.props.filter((x) => typeof x === 'number');
    const name = String(p.props[0]);
    if (name === 'UpAxis') upAxis = Number(v[v.length - 1] ?? 1);
    if (name === 'UnitScaleFactor') unitScale = Number(v[v.length - 1] ?? 1) || 1;
    if (name === 'FrameRate') frameRate = Number(v[v.length - 1] ?? 0) || 0;
    if (name === 'TimeMode') timeMode = Number(v[v.length - 1] ?? 0) || 0;
  }
  // FBX KTimeMode：0 是「用 FrameRate 属性」，其余是预设帧率。文件没写就按 30fps，
  // 逐帧工具条据此把秒换算成整数帧；这里只影响显示与步进，不改变曲线求值（仍按 tick）。
  const TIMEMODE_FPS = { 1: 120, 2: 100, 3: 60, 4: 50, 5: 48, 6: 30, 7: 30,
    8: 29.97, 9: 29.97, 10: 25, 11: 24, 12: 1000, 13: 24 };
  const fps = frameRate > 0 ? frameRate : (TIMEMODE_FPS[timeMode] || 30);
  // 3D 预览把 Y 当竖直方向；FBX 默认 Y-up，Z-up 的文件整体转一次轴
  const axis = upAxis === 2 ? [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] : IDENT();
  const base = matMul(axis, fbxScale([unitScale, unitScale, unitScale]));

  const version = ascii ? 0 : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(23, true);
  const mb = new MeshBuilder('fbx', ascii ? 'FBX ASCII 网格' : `FBX ${version} 二进制网格`);
  const geoms = new Map(), models = new Map(), mats = new Map(), deformers = new Map();
  const curveNodes = new Map(), curvesById = new Map(), stacks = [], stackById = new Map();
  const layers = new Map();   // AnimationLayer：一个 Take 内可以有多层
  let hasSkin = false;
  for (const c of objects.children) {
    const id = String(Number(c.props[0]));
    switch (c.name) {
      case 'Geometry': geoms.set(id, c); break;
      case 'Model': models.set(id, c); break;
      case 'Material': mats.set(id, c); break;
      case 'AnimationCurve': curvesById.set(id, c); break;
      case 'AnimationCurveNode': curveNodes.set(id, c); break;
      case 'AnimationStack': stacks.push(c); stackById.set(id, c); break;
      case 'AnimationLayer': layers.set(id, c); break;
      case 'Deformer': deformers.set(id, c); if (/skin|cluster/i.test(String(c.props[2] || ''))) hasSkin = true; break;
      default: break;
    }
  }
  if (!geoms.size) throw new Error('FBX 里没有 Geometry（可能只是灯光 / 相机工程）');

  const matColors = new Map();
  for (const [id, m] of mats) {
    const v = fbxPropVals(m, 'DiffuseColor') || fbxPropVals(m, 'Diffuse');
    if (v && v.length >= 3) matColors.set(id, [0, 1, 2].map((i) => clamp255(v[i] * 255)));
  }

  const parentOf = new Map(), geomOf = new Map(), matOf = new Map();
  const skinOfGeom = new Map(), clusterSkin = new Map(), clusterBone = new Map();
  // 形态键连接：Shape >-< BlendShapeChannel >-< BlendShape >-< 基础 Geometry
  // 各段在真实文件里通常是 1-1 / 1-多，但规范允许双向与重复连接，这里统一去重。
  const shapeToChannel = new Map(), channelToBlend = new Map(), blendToGeom = new Map();
  // 动画归属：Layer → Stack，CurveNode → Layer
  const layerToStack = new Map(), curveNodeToLayer = new Map();
  const addLink = (m, k, v) => {
    const s = m.get(k) || new Set();
    s.add(v);
    m.set(k, s);
  };
  const deformerSub = (id) => String(deformers.get(id)?.props[2] || '');
  const isSkin = (id) => /skin/i.test(deformerSub(id));
  const isCluster = (id) => /cluster/i.test(deformerSub(id));
  const isMorph = (id) => /blend.?shape/i.test(deformerSub(id)) && !/channel/i.test(deformerSub(id));
  const isChannel = (id) => /blend.?shape.?channel/i.test(deformerSub(id));
  const isShapeGeom = (id) => String(geoms.get(id)?.props[2] || '') === 'Shape';
  const ops = [];
  for (const c of fbxKids(conns, 'C')) {
    const [ty, a, b, prop] = c.props;
    const ch = String(Number(a)), pa = String(Number(b));
    if (ty === 'OO') {
      if (models.has(ch) && models.has(pa)) parentOf.set(ch, pa);
      else if (geoms.has(ch) && models.has(pa)) geomOf.set(pa, ch);
      else if (mats.has(ch) && models.has(pa)) matOf.set(pa, ch);
      else if (isCluster(ch) && isSkin(pa)) clusterSkin.set(ch, pa);
      else if (isCluster(ch) && models.has(pa)) clusterBone.set(ch, pa);
      else if (isCluster(pa) && models.has(ch)) clusterBone.set(pa, ch);
      else if (isSkin(ch) && geoms.has(pa)) skinOfGeom.set(pa, ch);
      else if (isSkin(pa) && geoms.has(ch)) skinOfGeom.set(ch, pa);
      else if (layers.has(ch) && stackById.has(pa)) layerToStack.set(ch, pa);
      else if (layers.has(pa) && stackById.has(ch)) layerToStack.set(pa, ch);
      else if (curveNodes.has(ch) && layers.has(pa)) curveNodeToLayer.set(ch, pa);
      else if (curveNodes.has(pa) && layers.has(ch)) curveNodeToLayer.set(pa, ch);
      else if (isChannel(ch) && isMorph(pa)) addLink(channelToBlend, ch, pa);
      else if (isChannel(pa) && isMorph(ch)) addLink(channelToBlend, pa, ch);
      else if (isMorph(ch) && geoms.has(pa)) addLink(blendToGeom, ch, pa);
      else if (isMorph(pa) && geoms.has(ch)) addLink(blendToGeom, pa, ch);
      else if (isShapeGeom(ch) && isChannel(pa)) addLink(shapeToChannel, ch, pa);
      else if (isShapeGeom(pa) && isChannel(ch)) addLink(shapeToChannel, pa, ch);
    } else if (ty === 'OP') ops.push({ child: ch, parent: pa, prop: String(prop || '') });
  }

  // 形态键数据：Shape 的 Indexes / Vertices 是相对基础网格的稀疏增量；
  // Channel 的 DeformPercent 是默认激活百分比，FullWeights 是 in-between 的满权重阈值。
  const morphChannels = new Map();   // BlendShapeChannel id → { id, shapes, full, def, curve }
  const morphOfGeom = new Map();     // 基础 Geometry id → [channel, ...]
  if (deformers.size) {
    const channelShapes = new Map(), channelGeoms = new Map();
    for (const [sid, chs] of shapeToChannel) {
      if (!geoms.has(sid)) continue;
      for (const cid of chs) {
        const arr = channelShapes.get(cid) || [];
        if (!arr.includes(sid)) arr.push(sid);
        channelShapes.set(cid, arr);
      }
    }
    // channelToBlend 是 Channel → BlendShape，BlendShape 再连到基础 Geometry
    for (const [cid, bss] of channelToBlend) {
      const arr = channelGeoms.get(cid) || [];
      for (const bs of bss) {
        for (const gid of (blendToGeom.get(bs) || [])) if (!arr.includes(gid)) arr.push(gid);
      }
      channelGeoms.set(cid, arr);
    }
    for (const [cid, sgids] of channelShapes) {
      const cnode = deformers.get(cid);
      // Blender 把 DeformPercent 写成 Channel 的直接子节点，部分导出器写在 Properties70 里
      const dpNode = fbxFirst(cnode, 'DeformPercent');
      const dpVal = dpNode && dpNode.props.length ? Number(dpNode.props[0]) : null;
      const dpProp = fbxPropVals(cnode, 'DeformPercent');
      const def = dpVal !== null && Number.isFinite(dpVal) ? dpVal
        : (dpProp && dpProp.length ? Number(dpProp[dpProp.length - 1]) : 100);
      const fw = fbxArray(fbxFirst(cnode, 'FullWeights'));
      const shapes = [];
      for (let j = 0; j < sgids.length; j++) {
        const sg = geoms.get(sgids[j]);
        const ix = fbxArray(fbxFirst(sg, 'Indexes'));
        const dv = fbxArray(fbxFirst(sg, 'Vertices'));
        const n = Math.min(ix.length, Math.floor(dv.length / 3));
        if (!n) continue;
        const idx = new Int32Array(n), delta = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          idx[k] = Math.round(ix[k]);
          delta[k * 3] = dv[k * 3];
          delta[k * 3 + 1] = dv[k * 3 + 1];
          delta[k * 3 + 2] = dv[k * 3 + 2];
        }
        shapes.push({ idx, d: delta, full: fw.length > j && Number.isFinite(fw[j]) ? fw[j] : 100 });
      }
      if (!shapes.length) continue;
      // FullWeights 是「该 Shape 被完全激活时的百分比」，按阈值升序排列才能做区间插值
      shapes.sort((x, y) => x.full - y.full);
      const chan = {
        id: cid, shapes, full: shapes.map((s) => s.full),
        def: Number.isFinite(def) ? def : 100,
      };
      morphChannels.set(cid, chan);
      for (const gid of (channelGeoms.get(cid) || [])) {
        const arr = morphOfGeom.get(gid) || [];
        if (!arr.includes(chan)) arr.push(chan);
        morphOfGeom.set(gid, arr);
      }
    }
  }

  // ---- 动画 Take / 层 ----
  // AnimationStack 是一个 Take；Stack 下挂 AnimationLayer，Layer 的 Weight 是 0–100 百分比。
  // CurveNode 通过 CurveNode → Layer 连接归属到具体 Take / 层，播放时按层顺序线性混合。
  // 二进制 FBX 的对象名常带 "\x00\x01AnimStack" 之类的尾巴，展示前切干净
  const fbxName = (raw, fallback) => {
    const t = String(raw || '').split('\x00')[0].replace(/^.*::/, '').trim();
    return t || fallback;
  };
  const layerInfo = new Map();   // layerId → { id, stackId, name, weight, order }
  for (const [id, node] of layers) {
    const wv = fbxPropVals(node, 'Weight');
    const rawW = wv && wv.length ? Number(wv[wv.length - 1]) : 100;
    layerInfo.set(id, {
      id,
      stackId: layerToStack.get(id) || null,
      name: fbxName(node.props[1], `层 ${layerInfo.size + 1}`),
      weight: Number.isFinite(rawW) ? rawW : 100,
      order: layerInfo.size,
    });
  }
  const takeDefs = stacks.map((s) => {
    const a = fbxPropVals(s, 'LocalStart'), b = fbxPropVals(s, 'LocalStop');
    return {
      id: String(Number(s.props[0])),
      name: fbxName(s.props[1], '动画'),
      start: a && a.length ? Number(a[a.length - 1]) : NaN,
      stop: b && b.length ? Number(b[b.length - 1]) : NaN,
      layers: [],
    };
  });
  const takeIndexByStack = new Map();
  takeDefs.forEach((td, i) => {
    if (!takeIndexByStack.has(td.id)) takeIndexByStack.set(td.id, i);
  });
  for (const info of layerInfo.values()) {
    const i = info.stackId ? takeIndexByStack.get(info.stackId) : undefined;
    if (i !== undefined) takeDefs[i].layers.push(info);
  }

  // 节点按层级深度排序，算世界矩阵时父节点一定已经算好
  const ids = [...models.keys()];
  const depth = new Map(), seen = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const p = parentOf.get(id);
    const d = p && models.has(p) ? 1 + depthOf(p) : 0;
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  ids.sort((a, b) => depthOf(a) - depthOf(b));
  const idxOf = new Map(ids.map((id, i) => [id, i]));
  const nodes = ids.map((id) => {
    const m = models.get(id);
    const rotOrder = fbxPropVals(m, 'RotationOrder');
    return {
      id, name: String(m.props[1] || ''),
      t: fbxPropVals(m, 'Lcl Translation') || [0, 0, 0],
      r: fbxPropVals(m, 'Lcl Rotation') || [0, 0, 0],
      s: fbxPropVals(m, 'Lcl Scaling') || [1, 1, 1],
      pre: fbxPropVals(m, 'PreRotation') || [0, 0, 0],
      order: rotOrder && rotOrder.length ? Math.round(rotOrder[rotOrder.length - 1]) : 0,
      pivot: fbxPropVals(m, 'RotationPivot'),
      offset: fbxPropVals(m, 'RotationOffset'),
      parentIdx: parentOf.has(id) && idxOf.has(parentOf.get(id)) ? idxOf.get(parentOf.get(id)) : -1,
    };
  });
  const worldRest = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const n = nodes[i];
    const pw = n.parentIdx >= 0 ? worldRest[n.parentIdx] : base;
    worldRest[i] = matMul(pw, fbxLocal(n.t, n.pre, n.r, n.s, n.order, n.pivot, n.offset));
  }

  // 绑定姿态：优先用 Pose 节点里的 Matrix（部分导出器不写 Cluster.TransformLink）
  const poseBind = new Map();
  const poseNode = fbxFirst(objects, 'Pose') || fbxFirst(root, 'Pose');
  for (const pn of fbxKids(poseNode, 'PoseNode')) {
    const nid = fbxFirst(pn, 'Node');
    const mat = fbxArray(fbxFirst(pn, 'Matrix'));
    if (!nid || !nid.props.length || mat.length < 16) continue;
    const key = String(Number(nid.props[0]));
    if (models.has(key)) poseBind.set(key, mat.slice(0, 16));
  }

  // 动画：Curve -> CurveNode 的 OP 给通道 d|X/Y/Z（形态键是 d|DeformPercent），
  // CurveNode -> Model 的 OP 给属性名，CurveNode -> BlendShapeChannel 给 DeformPercent，
  // CurveNode -> AnimationLayer 决定它属于哪个 Take / 层。
  const CHAN = { 'd|X': 0, 'd|Y': 1, 'd|Z': 2, X: 0, Y: 1, Z: 2 };
  const takeNodeCurves = takeDefs.map(() => []);
  const takeMorphCurves = takeDefs.map(() => []);
  const orphanNodeCurves = [], orphanMorphCurves = [];
  let unsupported = 0;
  for (const l of ops) {
    const c = curvesById.get(l.child);
    if (!c || !curveNodes.has(l.parent)) continue;
    const ml = ops.find((o) => o.child === l.parent && (models.has(o.parent) || morphChannels.has(o.parent)));
    if (!ml) continue;
    const times = fbxArray(fbxFirst(c, 'KeyTime'));
    const values = fbxArray(fbxFirst(c, 'KeyValueFloat'));
    if (!times.length || !values.length) continue;
    const layerId = curveNodeToLayer.get(l.parent) || null;
    const li = layerId ? layerInfo.get(layerId) : null;
    const stackId = li ? li.stackId : null;
    const takeIdx = stackId && takeIndexByStack.has(stackId) ? takeIndexByStack.get(stackId) : -1;
    const base = {
      times, values, layerId,
      weight: li ? li.weight : 100,
      order: li ? li.order : 0,
    };
    if (models.has(ml.parent)) {
      if (!['Lcl Translation', 'Lcl Rotation', 'Lcl Scaling'].includes(ml.prop)) { unsupported++; continue; }
      const node = idxOf.get(ml.parent);
      if (node === undefined) continue;
      (takeIdx >= 0 ? takeNodeCurves[takeIdx] : orphanNodeCurves)
        .push({ ...base, node, prop: ml.prop, channel: CHAN[l.prop] ?? 0 });
    } else {
      const chan = morphChannels.get(ml.parent);
      if (!chan || ml.prop !== 'DeformPercent' ||
          (l.prop !== 'd|DeformPercent' && l.prop !== 'DeformPercent')) { unsupported++; continue; }
      (takeIdx >= 0 ? takeMorphCurves[takeIdx] : orphanMorphCurves).push({ ...base, chan });
    }
  }

  // 有些导出器不写 Stack / Layer 连接：把游离曲线放进第一个 Take，保证老文件还能播
  if (!takeDefs.length) {
    takeDefs.push({
      id: null, name: '动画', start: NaN, stop: NaN,
      layers: [...layerInfo.values()],
    });
    takeNodeCurves.push([]);
    takeMorphCurves.push([]);
    if (!takeDefs[0].layers.length) {
      takeDefs[0].layers.push({ id: null, name: 'BaseLayer', weight: 100, order: 0 });
    }
  }
  if (orphanNodeCurves.length || orphanMorphCurves.length) {
    const first = takeDefs[0];
    for (const info of layerInfo.values()) {
      if (!info.stackId && !first.layers.includes(info)) first.layers.push(info);
    }
    takeNodeCurves[0].push(...orphanNodeCurves);
    takeMorphCurves[0].push(...orphanMorphCurves);
  }

  // 每个 Take 独立算起止时间；没有 LocalStart/Stop 的从自己的曲线范围推。
  // 再按层顺序把曲线排好，播放时依次做 Weight 线性混合。
  const takes = [];
  for (let i = 0; i < takeDefs.length; i++) {
    const td = takeDefs[i];
    let start = td.start, stop = td.stop;
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) {
      start = Infinity; stop = -Infinity;
      for (const c of [...takeNodeCurves[i], ...takeMorphCurves[i]]) {
        start = Math.min(start, c.times[0]);
        stop = Math.max(stop, c.times[c.times.length - 1]);
      }
    }
    if (!(stop > start) || !Number.isFinite(start) || !Number.isFinite(stop)) continue;
    if (!takeNodeCurves[i].length && !takeMorphCurves[i].length) continue;
    const nc = takeNodeCurves[i].slice().sort((x, y) => x.order - y.order);
    const mc = takeMorphCurves[i].slice().sort((x, y) => x.order - y.order);
    const byNode = new Map(), morphByChan = new Map();
    for (const c of nc) {
      const arr = byNode.get(c.node) || [];
      arr.push(c);
      byNode.set(c.node, arr);
    }
    for (const c of mc) {
      const arr = morphByChan.get(c.chan) || [];
      arr.push(c);
      morphByChan.set(c.chan, arr);
    }
    takes.push({
      name: td.name, start, stop,
      layers: td.layers.map((li) => ({ name: li.name, weight: li.weight })),
      nodeCurves: nc, morphCurves: mc, byNode, morphByChan,
    });
  }
  const hasAnim = takes.length > 0;

  const cpPos = [], cpNode = [], triCp = [];
  const cpOfNode = new Map();   // 网格节点索引 → 该几何控制点在全局控制点表里的起点 / 数量
  const meshRecs = [];          // 发射参数延后：先收齐控制点与默认定形，再统一发三角形
  let emitted = 0, vertexCount = 0;
  for (let i = 0; i < ids.length; i++) {
    const gid = geomOf.get(nodes[i].id);
    if (!gid) continue;
    const g = geoms.get(gid);
    if (isShapeGeom(gid)) continue;   // Shape 几何只存增量，不是可显示网格
    const vs = fbxArray(fbxFirst(g, 'Vertices'));
    const pvi = fbxArray(fbxFirst(g, 'PolygonVertexIndex'));
    if (vs.length < 9 || !pvi.length) continue;
    const nv = Math.floor(vs.length / 3);
    const cpOff = cpPos.length / 3;
    for (let k = 0; k < nv; k++) {
      cpPos.push(vs[k * 3], vs[k * 3 + 1], vs[k * 3 + 2]);
      cpNode.push(i);
    }
    cpOfNode.set(i, { offset: cpOff, count: nv });
    meshRecs.push({
      gid, nv, cpOff, pvi, W: worldRest[i], layers: fbxUvLayers(g), sourceNormals: fbxCornerNormals(g),
      color: matColors.get(matOf.get(nodes[i].id)) || DEFAULT_COLOR,
    });
    vertexCount += nv;
  }

  // 每个网格节点挂上形态键通道；通道对象按几何共享，发射时按节点的 cpOff 平移下标
  const morphs = [];
  for (const rec of meshRecs) {
    const chans = morphOfGeom.get(rec.gid);
    if (chans && chans.length) morphs.push({ cpOff: rec.cpOff, channels: chans });
  }

  // 静止显示用文件里的 DeformPercent 作为默认定形（有曲线时取当前 Take 起始时刻的值），
  // 这样没有动画的形态键样本也能直接看到形态；播放时再逐帧求值。
  const cpCount = cpPos.length / 3;
  let restCp = null;
  if (morphs.length) {
    restCp = Float32Array.from(cpPos);
    const tk0 = takes.length ? takes[0] : null;
    applyMorphs(restCp, morphs,
      (chan) => takeMorphPct(tk0, chan, tk0 ? tk0.start : 0), cpCount);
  }

  const srcCp = restCp || cpPos;
  for (const rec of meshRecs) {
    const W = rec.W;
    const raw = (k) => {
      if (k < 0 || k >= rec.nv) return null;
      const q = rec.cpOff + k;
      return [srcCp[q * 3], srcCp[q * 3 + 1], srcCp[q * 3 + 2]];
    };
    let poly = [];
    for (let pv = 0; pv < rec.pvi.length; pv++) {
      const v = rec.pvi[pv];
      const k = v < 0 ? -v - 1 : v;
      poly.push({ k, pv });
      if (v >= 0) continue;
      for (let j = 1; j < poly.length - 1; j++) {
        const p0 = poly[0], p1 = poly[j], p2 = poly[j + 1];
        const la = raw(p0.k), lb = raw(p1.k), lc = raw(p2.k);
        if (!la || !lb || !lc) { mb.warn('FBX 面索引越界'); continue; }
        if (mb.addTri(applyMat(W, la), applyMat(W, lb), applyMat(W, lc), rec.color,
          fbxUvTri(rec.layers, p0, p1, p2),
          [p0,p1,p2].map(p=>rec.sourceNormals[p.pv] ? transformNormal(W,rec.sourceNormals[p.pv]) : null))) {
          mb.setOriginFromMatrix(W, base);   // W 已含 base（UpAxis / UnitScale）与节点层级
          triCp.push(rec.cpOff + p0.k, rec.cpOff + p1.k, rec.cpOff + p2.k);
          emitted++;
        }
      }
      poly = [];
    }
  }
  if (!emitted) {
    // Connections 不规范的导出器：不管层级，把所有 Geometry 按全局轴变换画出来
    for (const g of geoms.values()) {
      if (String(g.props[2] || '') === 'Shape') continue;
      const vs = fbxArray(fbxFirst(g, 'Vertices'));
      const pvi = fbxArray(fbxFirst(g, 'PolygonVertexIndex'));
      const layers = fbxUvLayers(g), sourceNormals = fbxCornerNormals(g);
      let poly = [];
      for (let pv = 0; pv < pvi.length; pv++) {
        const v = pvi[pv];
        const k = v < 0 ? -v - 1 : v;
        poly.push({ k, pv });
        if (v >= 0) continue;
        for (let j = 1; j < poly.length - 1; j++) {
          const q3 = [poly[0], poly[j], poly[j + 1]];
          const p = (q) => q >= 0 && q * 3 + 2 < vs.length
            ? applyMat(base, [vs[q * 3], vs[q * 3 + 1], vs[q * 3 + 2]]) : null;
          const a = p(q3[0].k), b = p(q3[1].k), c = p(q3[2].k);
          if (a && b && c) {
            if (mb.addTri(a, b, c, DEFAULT_COLOR, fbxUvTri(layers, q3[0], q3[1], q3[2]), q3.map(p=>sourceNormals[p.pv] ? transformNormal(base,sourceNormals[p.pv]) : null))) {
              mb.setOriginFromMatrix(base, base);  // 无 Connections：只有全局轴 / 单位变换
              emitted++;
            }
          }
        }
        poly = [];
      }
      vertexCount += Math.floor(vs.length / 3);
    }
  }
  if (!emitted) throw new Error('FBX 里没有可显示的多边形');
  mb.vertices = vertexCount || mb.pos.length / 3;

  // 骨骼蒙皮：Cluster 的 TransformLink 是骨骼在绑定姿态下的世界矩阵（与 Pose 里的
  // Matrix 等值，缺 TransformLink 时用 Pose 兜底），权重挂在控制点上。
  // 每根骨骼的绑定偏移 = inv(绑定世界) × 网格节点的静止世界；播放时
  // 调色板 = 当前骨骼世界 × 该偏移，即把「绑定姿态的网格空间」带到当前骨骼姿态。
  const skins = new Map();   // 网格节点索引 → { cpOff, cpCount, bones, adjs, cpBone, cpW }
  if (hasSkin) {
    let skipped = 0;
    for (const [nodeIdx, info] of cpOfNode) {
      const gid = geomOf.get(nodes[nodeIdx].id);
      const skinId = skinOfGeom.get(gid);
      if (!skinId) { skipped++; continue; }
      const cls = [];
      for (const [cid, sid] of clusterSkin) {
        if (sid !== skinId) continue;
        const boneId = clusterBone.get(cid);
        if (!boneId || !idxOf.has(boneId)) continue;
        cls.push({ cid, boneIdx: idxOf.get(boneId), boneId });
      }
      if (!cls.length) { skipped++; continue; }
      const nB = cls.length;
      const bones = new Int32Array(nB), adjs = [];
      for (let b = 0; b < nB; b++) {
        const cl = cls[b];
        const cn = deformers.get(cl.cid);
        let tl = fbxArray(fbxFirst(cn, 'TransformLink'));
        if (tl.length < 16) tl = poseBind.get(cl.boneId) || null;
        const bind = tl ? matMul(base, tl.slice(0, 16)) : worldRest[cl.boneIdx];
        bones[b] = cl.boneIdx;
        adjs.push(matMul(matInv(bind), worldRest[nodeIdx]));
      }
      const cpCount = info.count;
      const cpBone = new Uint16Array(cpCount * 4), cpW = new Float32Array(cpCount * 4);
      const inf = new Array(cpCount);
      for (let b = 0; b < nB; b++) {
        const cn = deformers.get(cls[b].cid);
        const ix = fbxArray(fbxFirst(cn, 'Indexes'));
        const wt = fbxArray(fbxFirst(cn, 'Weights'));
        const nw = Math.min(ix.length, wt.length);
        for (let j = 0; j < nw; j++) {
          const k = Math.round(ix[j]);
          if (k < 0 || k >= cpCount || !(wt[j] > 0)) continue;
          (inf[k] || (inf[k] = [])).push([b, wt[j]]);
        }
      }
      let clamped = false;
      for (let k = 0; k < cpCount; k++) {
        const list = inf[k];
        if (!list) continue;
        if (list.length > 4) { list.sort((x, y) => y[1] - x[1]); clamped = true; }
        const n = Math.min(4, list.length);
        let sum = 0;
        for (let s = 0; s < n; s++) sum += list[s][1];
        if (!(sum > 0)) continue;
        for (let s = 0; s < n; s++) {
          cpBone[k * 4 + s] = list[s][0];
          cpW[k * 4 + s] = list[s][1] / sum;
        }
      }
      if (clamped) mb.warn('FBX 蒙皮有顶点受超过 4 根骨骼影响，已保留权重最大的 4 根');
      skins.set(nodeIdx, { cpOff: info.offset, cpCount, bones, adjs, cpBone, cpW });
    }
    if (hasAnim && !skins.size) {
      mb.warn(skipped ? 'FBX 蒙皮数据不完整，动画只做节点变换' : 'FBX 没有找到可用的蒙皮数据');
    }
  }
  const boneIds = new Set(clusterBone.values());
  for (const [id, node] of models) {
    if (/^(LimbNode|Limb|Root|Skeleton)$/i.test(String(node.props[2] || ''))) boneIds.add(id);
  }
  mb.boneCount = boneIds.size;
  if (unsupported) mb.warn(`FBX 有 ${unsupported} 条非位移 / 旋转 / 缩放 / 形态键动画曲线未求值`);
  if (upAxis === 2) mb.warn('FBX 是 Z-up，已转换成 Y-up 显示');

  const model = mb.finish();
  // 动画数据挂在模型上：cpPos / cpNode 是未变换的控制点，triCp 让每个三角形回指
  // 三个控制点；播放时按当前骨骼姿态重算 pos / nrm，bounds 与 minY 仍按静止姿态固定。
  if (hasAnim && emitted === triCp.length / 3) {
    const tk0 = takes[0];
    const duration = (tk0.stop - tk0.start) / FBX_TICKS;
    model.anim = {
      ticks: FBX_TICKS,
      take: 0, takes,
      name: tk0.name,
      start: tk0.start, stop: tk0.stop,
      duration,
      // 帧率与总帧数只给工具条用：曲线求值仍按 tick 做，逐帧显示 = round(秒 × fps)
      fps, frames: Math.max(1, Math.round(duration * fps)),
      base, nodes, curves: tk0.nodeCurves,
      cpPos: Float32Array.from(cpPos),
      cpNode: Uint32Array.from(cpNode),
      triCp: Uint32Array.from(triCp),
      skins: skins.size ? skins : null,
      morphs: morphs.length ? morphs : null,
    };
  }
  return model;
}

// 在给定时间点（秒）把模型摆到对应姿态：原地改写 pos / nrm，
// renderModel 不用知道动画的存在。返回 false 表示这个模型没有动画。
// 按 FBX 曲线在 t（tick）时刻求每个节点的世界矩阵
function fbxWorld(a, tk, t) {
  const world = new Array(a.nodes.length);
  for (let i = 0; i < a.nodes.length; i++) {
    const n = a.nodes[i];
    const tv = n.t.slice(), rv = n.r.slice(), sv = n.s.slice();
    const cs = tk.byNode.get(i);
    if (cs) for (const c of cs) {
      const w = layerWeight(c.weight);
      if (!(w > 0) || c.channel >= 3) continue;
      const arr = c.prop === 'Lcl Translation' ? tv : c.prop === 'Lcl Rotation' ? rv : sv;
      const v = fbxSample(c, t);
      arr[c.channel] = w >= 1 ? v : arr[c.channel] * (1 - w) + v * w;
    }
    const pw = n.parentIdx >= 0 && world[n.parentIdx] ? world[n.parentIdx] : a.base;
    world[i] = matMul(pw, fbxLocal(tv, n.pre, rv, sv, n.order, n.pivot, n.offset));
  }
  return world;
}

// 把控制点按 world 摆好、蒙皮、重算三角形与法线；FBX 与 glTF 动画共用这一半
function poseFromWorld(model, a, tk, t, world) {
  const { center, k } = model.normalize;
  const cpPos = a.cpPos, cpNode = a.cpNode, triCp = a.triCp;
  // 0) 形态键：在基础控制点上叠加当前时刻的增量（glTF 的 morph targets 暂不还原）
  let src = cpPos;
  if (a.morphs && a.morphs.length) {
    const dst = a._cpMorph && a._cpMorph.length === cpPos.length
      ? a._cpMorph : (a._cpMorph = new Float32Array(cpPos.length));
    dst.set(cpPos);
    const pct = a._pct || (a._pct = new Map());
    pct.clear();
    applyMorphs(dst, a.morphs, (chan) => {
      let v = pct.get(chan);
      if (v === undefined) {
        v = takeMorphPct(tk, chan, t);
        pct.set(chan, v);
      }
      return v;
    }, cpPos.length / 3);
    src = dst;
  }
  // 1) 先按各自网格节点的世界变换摆好控制点；没有蒙皮数据时结果就是节点动画
  const cpWorld = a._cpWorld && a._cpWorld.length === cpPos.length
    ? a._cpWorld : (a._cpWorld = new Float32Array(cpPos.length));
  for (let c = 0; c < cpNode.length; c++) {
    const m = world[cpNode[c]] || IDENT();
    const x = src[c * 3], y = src[c * 3 + 1], z = src[c * 3 + 2];
    cpWorld[c * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12] - center[0]) * k;
    cpWorld[c * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13] - center[1]) * k;
    cpWorld[c * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14] - center[2]) * k;
  }
  // 2) 蒙皮控制点：调色板 = 当前关节世界 × 绑定偏移，按每点最多 4 根骨骼线性混合
  if (a.skins) for (const sk of a.skins.values()) {
    const palette = sk.adjs.map((adj, b) => matMul(world[sk.bones[b]] || IDENT(), adj));
    for (let c = 0; c < sk.cpCount; c++) {
      const q = sk.cpOff + c;
      const x = src[q * 3], y = src[q * 3 + 1], z = src[q * 3 + 2];
      let px = 0, py = 0, pz = 0;
      for (let s2 = 0; s2 < 4; s2++) {
        const w = sk.cpW[c * 4 + s2];
        if (!w) continue;
        const m = palette[sk.cpBone[c * 4 + s2]];
        if (!m) continue;
        px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      cpWorld[q * 3] = (px - center[0]) * k;
      cpWorld[q * 3 + 1] = (py - center[1]) * k;
      cpWorld[q * 3 + 2] = (pz - center[2]) * k;
    }
  }
  // 3) 三角形从控制点表取三个角，再逐面重算法线
  const pos = model.pos, nrm = model.nrm;
  for (let t2 = 0; t2 < model.triangles; t2++) {
    const o = t2 * 9;
    for (let j = 0; j < 3; j++) {
      const c = triCp[t2 * 3 + j];
      const i = o + j * 3;
      pos[i] = cpWorld[c * 3];
      pos[i + 1] = cpWorld[c * 3 + 1];
      pos[i + 2] = cpWorld[c * 3 + 2];
    }
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[t2 * 3] = nx / len; nrm[t2 * 3 + 1] = ny / len; nrm[t2 * 3 + 2] = nz / len;
  }
  model.normalPoseDirty = true;
  return true;
}

// 在给定时间点（秒）把模型摆到对应姿态：原地改写 pos / nrm，
// renderModel 不用知道动画的存在。返回 false 表示这个模型没有动画。
export function applyModelAnimation(model, seconds) {
  const a = model && model.anim;
  if (!a || !a.takes || !a.takes.length) return false;
  const tk = a.takes[a.take] || a.takes[0];
  const t = tk.start + Math.max(0, seconds) * a.ticks;
  // FBX 用 tick 采曲线，glTF 的 input 直接是秒，两套 world 计算完走同一套姿态重算
  const world = a.kind === 'gltf' ? gltfWorld(a, tk, seconds) : fbxWorld(a, tk, t);
  return poseFromWorld(model, a, tk, t, world);
}

// 切换动画 Take：把当前 Take 的时长 / 帧数同步到 anim 上，
// 工具条随后按新的时间轴重新播放；返回 false 表示没有可切换的 Take。
export function useAnimationTake(model, index) {
  const a = model && model.anim;
  if (!a || !a.takes || !a.takes.length) return false;
  const i = Math.max(0, Math.min(a.takes.length - 1, Math.round(index)));
  const tk = a.takes[i];
  a.take = i;
  a.name = tk.name;
  a.start = tk.start;
  a.stop = tk.stop;
  a.duration = (tk.stop - tk.start) / a.ticks;
  a.frames = Math.max(1, Math.round(a.duration * a.fps));
  a.curves = tk.nodeCurves;
  return true;
}

export function resetModelPose(model) {
  if (model && model.restPos && model.restNrm) {
    model.pos.set(model.restPos);
    model.nrm.set(model.restNrm);
    if (model.cornerNrm) model.cornerNrm.set(model.restCornerNrm);
    model.normalPoseDirty = false;
  }
}

// ---------------- COLLADA / 3DS / AMF ----------------
//
// 三种都是「零依赖」补充格式：DAE / AMF 是 XML（DOMParser 已在 3MF 用过），
// 3DS 是最朴素的 6 字节 chunk 树。统一归约到 MeshBuilder 的三角形表。

const xmlDeep = (root, name) => Array.from(root.getElementsByTagName('*'))
  .filter((e) => XML_LOCAL(e).toLowerCase() === name.toLowerCase());
const numsOf = (el) => el ? (el.textContent || '').trim().split(/[\s,]+/).filter(Boolean).map(Number) : [];
function xmlDocument(text) {
  const doc = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'application/xml');
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error('XML 解析失败');
  return doc;
}

// COLLADA：source 是浮点数组 + accessor(stride)，vertices 把 POSITION 间接指过去，
// triangles / polylist / polygons 的 <p> 是按 input.offset 平铺的角索引。
async function parseDae(bytes) {
  const doc = xmlDocument(textOf(bytes));
  const root = doc.documentElement;
  if (XML_LOCAL(root).toLowerCase() !== 'collada') throw new Error('不是 COLLADA (.dae) 文件');
  const mb = new MeshBuilder('dae', 'COLLADA 数字资产交换 (.dae)');

  const fxColor = new Map();
  for (const eff of xmlDeep(root, 'effect')) {
    const id = eff.getAttribute('id');
    const dif = xmlDeep(eff, 'diffuse')[0];
    const col = dif ? xmlDeep(dif, 'color')[0] : xmlDeep(eff, 'color')[0];
    if (!id || !col) continue;
    const v = numsOf(col);
    if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
      fxColor.set(id, [v[0] * 255, v[1] * 255, v[2] * 255]);
    }
  }
  const matColor = new Map();
  for (const mat of xmlDeep(root, 'material')) {
    const id = mat.getAttribute('id');
    const inst = xmlDeep(mat, 'instance_effect')[0];
    const fx = inst ? (inst.getAttribute('url') || '').replace(/^#/, '') : '';
    if (id && fxColor.has(fx)) matColor.set(id, fxColor.get(fx));
  }

  const parseGeometry = (geo) => {
    const sources = new Map();
    for (const src of xmlDeep(geo, 'source')) {
      const id = src.getAttribute('id');
      const arr = xmlKids(src, 'float_array')[0];
      if (!id || !arr) continue;
      const data = numsOf(arr);
      const acc = xmlDeep(src, 'accessor')[0];
      let stride = 3, count = 0;
      if (acc) {
        stride = Number(acc.getAttribute('stride')) || xmlKids(acc, 'param').length || 3;
        count = Number(acc.getAttribute('count')) || 0;
      }
      sources.set(id, { data, stride, count: count || Math.floor(data.length / stride) });
    }
    const vertexSources = new Map();
    for (const v of xmlDeep(geo, 'vertices')) {
      const inp = xmlKids(v, 'input').find((i) => (i.getAttribute('semantic') || '') === 'POSITION');
      if (inp) vertexSources.set(v.getAttribute('id'), (inp.getAttribute('source') || '').replace(/^#/, ''));
    }
    const groups = [];
    // <triangles> 是 <mesh> 的子元素，而 geo 是 <geometry>，要往后代数找
    for (const prim of Array.from(geo.getElementsByTagName('*'))) {
      const tag = XML_LOCAL(prim).toLowerCase();
      if (!['triangles', 'polylist', 'polygons'].includes(tag)) continue;
      const inputs = xmlKids(prim, 'input').map((i) => ({
        semantic: i.getAttribute('semantic') || '',
        source: (i.getAttribute('source') || '').replace(/^#/, ''),
        offset: Number(i.getAttribute('offset') || 0),
      }));
      if (!inputs.length) continue;
      const stride = inputs.reduce((m, i) => Math.max(m, i.offset + 1), 0);
      if (!(stride > 0)) continue;
      const corners = (el) => {
        const a = numsOf(el), out = [];
        for (let i = 0; i + stride <= a.length; i += stride) out.push(a.slice(i, i + stride));
        return out;
      };
      const plist = xmlKids(prim, 'p');
      const color = matColor.get(prim.getAttribute('material')) || DEFAULT_COLOR;
      const srcOf = (inp) => sources.get(inp.semantic === 'VERTEX' ? vertexSources.get(inp.source) : inp.source);
      const vin = inputs.find((i) => i.semantic === 'VERTEX') || inputs.find((i) => i.semantic === 'POSITION');
      const nin = inputs.find((i) => i.semantic === 'NORMAL');
      const cin = inputs.find((i) => i.semantic === 'COLOR');
      if (!vin) continue;
      const posSrc = srcOf(vin), nrmSrc = nin && srcOf(nin), colSrc = cin && srcOf(cin);
      const item = { color, posSrc, nrmSrc, colSrc, vin, nin, cin, tris: [] };
      if (tag === 'triangles') {
        const c = plist.length ? corners(plist[0]) : [];
        for (let i = 0; i + 2 < c.length; i += 3) item.tris.push([c[i], c[i + 1], c[i + 2]]);
      } else if (tag === 'polylist') {
        const vc = numsOf(xmlKids(prim, 'vcount')[0]);
        const c = plist.length ? corners(plist[0]) : [];
        let at = 0;
        for (const n of vc) {
          for (let k = 2; k < n; k++) item.tris.push([c[at], c[at + k - 1], c[at + k]]);
          at += n;
        }
      } else {
        for (const pe of plist) {
          const c = corners(pe);
          for (let k = 2; k < c.length; k++) item.tris.push([c[0], c[k - 1], c[k]]);
        }
      }
      if (item.tris.length) groups.push(item);
    }
    return groups;
  };

  const geos = new Map();
  for (const lib of xmlDeep(root, 'library_geometries')) {
    for (const geo of xmlKids(lib, 'geometry')) {
      const id = geo.getAttribute('id');
      if (id) geos.set(id, parseGeometry(geo));
    }
  }
  if (!geos.size) throw new Error('COLLADA 里没有可显示的 geometry');

  const take = (src, corner, inp, k) => {
    if (!src) return k === 0 ? 0 : (k === 1 ? 0 : 0);
    const i = Math.round(corner[inp.offset] || 0);
    return src.data[i * src.stride + k] || 0;
  };
  const up = (xmlDeep(root, 'up_axis')[0] || {}).textContent || '';
  const zUp = /Z_UP/i.test(up);
  // COLLADA 的 <matrix> 按行主序写，matMul 用列主序，这里转置一次
  const axis = zUp ? [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] : IDENT();
  let daeVerts = 0;
  const emitGeo = (items, world) => {
    for (const it of items) {
      daeVerts += it.posSrc ? it.posSrc.count : 0;
      for (const tri of it.tris) {
        if (tri.some((c) => !c)) continue;
        const a = [0, 1, 2].map((k) => take(it.posSrc, tri[0], it.vin, k));
        const b = [0, 1, 2].map((k) => take(it.posSrc, tri[1], it.vin, k));
        const c = [0, 1, 2].map((k) => take(it.posSrc, tri[2], it.vin, k));
        let col = it.color;
        if (it.colSrc) {
          const q = tri.map((cn) => [0, 1, 2].map((k) => take(it.colSrc, cn, it.cin, k)));
          col = [(q[0][0] + q[1][0] + q[2][0]) / 3 * 255,
            (q[0][1] + q[1][1] + q[2][1]) / 3 * 255,
            (q[0][2] + q[1][2] + q[2][2]) / 3 * 255];
        }
        let corners = null;
        if (it.nrmSrc) {
          const q = tri.map((cn) => [0, 1, 2].map((k) => take(it.nrmSrc, cn, it.nin, k)));
          corners = q.map(n=>transformNormal(world,n));
        }
        if (mb.addTri(applyMat(world, a), applyMat(world, b), applyMat(world, c), col,
          null, corners)) mb.setOriginFromMatrix(world, axis);
      }
    }
  };

  const sceneEl = xmlDeep(root, 'visual_scene')[0];
  const walkNode = (node, parent) => {
    let m = parent;
    const mx = xmlKids(node, 'matrix')[0];
    if (mx) {
      const v = numsOf(mx);
      if (v.length === 16) {
        const cm = new Array(16);
        for (let r = 0; r < 4; r++) for (let c2 = 0; c2 < 4; c2++) cm[c2 * 4 + r] = v[r * 4 + c2];
        m = matMul(parent, cm);
      }
    }
    for (const ie of xmlKids(node, 'instance_geometry')) {
      const id = (ie.getAttribute('url') || '').replace(/^#/, '');
      if (geos.has(id)) emitGeo(geos.get(id), m);
    }
    for (const ch of xmlKids(node, 'node')) walkNode(ch, m);
  };
  if (sceneEl) {
    for (const n of xmlKids(sceneEl, 'node')) walkNode(n, axis);
  } else {
    for (const g of geos.values()) emitGeo(g, axis);
  }
  if (zUp) mb.warn('COLLADA 是 Z-up，已转换成 Y-up 显示');
  mb.vertices = daeVerts || mb.pos.length / 3;
  mb.materials.add('COLLADA');
  mb.boneCount = xmlDeep(root, 'node').filter(node => node.getAttribute('type') === 'JOINT').length;
  return mb.finish();
}

// 3DS：chunk = id(uint16 LE) + len(uint32 LE，含 6 字节头)，数据从 off+6 开始。
// 只取静态网格：0x4110 顶点表、0x4120 面表、0x4130 面材质分组、0xAFFF 漫反射色。
function parse3ds(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 6 || dv.getUint16(0, true) !== 0x4d4d || dv.getUint32(2, true) > bytes.length) {
    throw new Error('不是 3DS 文件（主块不是 0x4D4D）');
  }
  const mb = new MeshBuilder('3ds', '3D Studio 网格 (.3ds)');
  const walk = (off, end, cb) => {
    while (off + 6 <= end) {
      const id = dv.getUint16(off, true), len = dv.getUint32(off + 2, true);
      if (len < 6 || off + len > end) break;
      cb(id, off + 6, off + len);
      off += len;
    }
  };
  const cstr = (s, e) => {
    let p = s;
    while (p < e && bytes[p] !== 0) p++;
    return textOf(bytes.subarray(s, p));
  };
  const materials = new Map();
  const objects = [];
  const parseMaterial = (s, e) => {
    let name = '', color = null;
    walk(s, e, (id, cs, ce) => {
      if (id === 0xa000) name = cstr(cs, ce).toLowerCase();
      else if (id === 0xa020) {
        walk(cs, ce, (id2, ds, de) => {
          if ((id2 === 0x0010 || id2 === 0x0013) && de - ds >= 12) {
            color = [dv.getFloat32(ds, true) * 255, dv.getFloat32(ds + 4, true) * 255, dv.getFloat32(ds + 8, true) * 255];
          } else if ((id2 === 0x0011 || id2 === 0x0012) && de - ds >= 3) {
            color = [bytes[ds], bytes[ds + 1], bytes[ds + 2]];
          }
        });
      }
    });
    if (name) materials.set(name, color || DEFAULT_COLOR);
  };
  const parseObject = (s, e, name) => {
    const verts = [], faces = [], faceMats = [], smoothing = [];
    walk(s, e, (id, cs, ce) => {
      if (id !== 0x4100) return;                  // OBJ_TRIMESH
      walk(cs, ce, (id2, ds, de) => {
        if (id2 === 0x4110) {                     // TRI_VERTEXL
          const n = dv.getUint16(ds, true);
          if (ds + 2 + n * 12 > de) return;
          for (let i = 0; i < n; i++) {
            const o = ds + 2 + i * 12;
            // 3DS 是 Z-up：(x,y,z) → (x,z,-y)
            const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
            verts.push([x, z, -y]);
          }
        } else if (id2 === 0x4120) {              // TRI_FACEL1
          const n = dv.getUint16(ds, true);
          if (ds + 2 + n * 8 > de) return;
          for (let i = 0; i < n; i++) {
            const o = ds + 2 + i * 8;
            faces.push([dv.getUint16(o, true), dv.getUint16(o + 2, true), dv.getUint16(o + 4, true)]);
          }
          walk(ds+2+n*8,de,(sub,ss,se)=>{
            if(sub===0x4150)for(let f=0;f<n && ss+f*4+4<=se;f++)smoothing[f]=dv.getUint32(ss+f*4,true);
          });
        } else if (id2 === 0x4130) {              // TRI_FACEMAT
          let p = ds;
          while (p < de && bytes[p] !== 0) p++;
          const mn = textOf(bytes.subarray(ds, p)).toLowerCase();
          p++;
          if (p + 2 > de) return;
          const n = dv.getUint16(p, true); p += 2;
          for (let i = 0; i < n && p + 2 <= de; i++, p += 2) faceMats.push([dv.getUint16(p, true), mn]);
        }
      });
    });
    if (verts.length && faces.length) objects.push({ name, verts, faces, faceMats, smoothing });
  };
  const scan = (off, end) => walk(off, end, (id, s, e) => {
    if (id === 0x4d4d || id === 0x3d3d) scan(s, e);
    else if (id === 0xafff) parseMaterial(s, e);
    else if (id === 0x4000) {
      let q = s;
      while (q < e && bytes[q] !== 0) q++;
      parseObject(q + 1, e, textOf(bytes.subarray(s, q)));
    }
  });
  scan(0, Math.min(bytes.length, dv.getUint32(2, true) || bytes.length));
  if (!objects.length) throw new Error('3DS 里没有可显示的三角网格');

  let vc = 0;
  for (const o of objects) {
    const colors = new Array(o.faces.length).fill(DEFAULT_COLOR);
    const normals = o.smoothing.length ? groupNormals(o.verts,o.faces,o.smoothing,true) : null;
    for (const [fi, mn] of o.faceMats) {
      if (fi < colors.length && materials.has(mn)) colors[fi] = materials.get(mn);
    }
    for (const n of new Set(o.faceMats.map((f) => f[1]))) mb.materials.add(n);
    for (let i = 0; i < o.faces.length; i++) {
      const [i0, i1, i2] = o.faces[i];
      if (!o.verts[i0] || !o.verts[i1] || !o.verts[i2]) continue;
      mb.addTri(o.verts[i0], o.verts[i1], o.verts[i2], colors[i], null, normals?.[i]);
    }
    vc += o.verts.length;
  }
  mb.vertices = vc;
  mb.warn('3DS 是 Z-up，已转换成 Y-up 显示');
  return mb.finish();
}

// AMF：纯 XML，也允许整包 ZIP 压缩（复用 3MF 那套 zip.js）。
// material 给 0~1 RGB，object/mesh/vertices 给顶点，volume/triangle 给三个顶点下标。
async function parseAmf(bytes) {
  let xb = bytes;
  const zip = openZip(bytes);
  if (zip) {
    const ent = zip.entries.find((e) => /\.xml$/i.test(e.name) && !e.dir) || zip.entries.find((e) => !e.dir);
    if (!ent) throw new Error('AMF 压缩包里没有模型 XML');
    const d = await readZipEntry(zip, ent);
    if (!d) throw new Error('AMF 压缩包解不开');
    xb = d;
  }
  const doc = xmlDocument(textOf(xb));
  const root = doc.documentElement;
  if (XML_LOCAL(root).toLowerCase() !== 'amf') throw new Error('不是 AMF 文件（根元素不是 <amf>）');
  const mb = new MeshBuilder('amf', '增材制造格式 AMF (.amf)');
  const mats = new Map();
  for (const m of xmlDeep(root, 'material')) {
    const id = m.getAttribute('id'), c = xmlDeep(m, 'color')[0];
    if (!id || !c) continue;
    const f = (n) => Number((xmlFirst(c, n) || {}).textContent || 0) || 0;
    mats.set(id, [f('r') * 255, f('g') * 255, f('b') * 255]);
  }
  let vc = 0;
  for (const obj of xmlDeep(root, 'object')) {
    const mesh = xmlDeep(obj, 'mesh')[0];
    if (!mesh) continue;
    const verts = [];
    const vlist = xmlDeep(mesh, 'vertices')[0];
    for (const v of vlist ? xmlKids(vlist, 'vertex') : []) {
      const co = xmlFirst(v, 'coordinates');
      const f = (n) => Number((co ? xmlFirst(co, n) : null)?.textContent || 0) || 0;
      verts.push([f('x'), f('y'), f('z')]);
    }
    for (const vol of xmlKids(mesh, 'volume')) {
      const col = mats.get(vol.getAttribute('materialid')) || DEFAULT_COLOR;
      mb.materials.add(vol.getAttribute('materialid') || 'default');
      for (const t of xmlKids(vol, 'triangle')) {
        const idx = ['v1', 'v2', 'v3'].map((n) => Number((xmlFirst(t, n) || {}).textContent || 0));
        if (idx.some((i) => i < 0 || i >= verts.length)) continue;
        mb.addTri(verts[idx[0]], verts[idx[1]], verts[idx[2]], col);
      }
    }
    vc += verts.length;
  }
  mb.vertices = vc || mb.pos.length / 3;
  return mb.finish();
}

// ---------------- 对外入口 ----------------

export async function parseModel(bytes, ext, opts = {}) {
  const resolveUri = opts.resolveUri || (async () => null);
  const e = String(ext || '').toLowerCase();
  if (!MODEL_EXTS.includes(e)) throw new Error(`不支持的 3D 格式：${e}`);
  if (!bytes || bytes.length < 12) throw new Error('3D 文件太短或读不到内容');
  if (e === 'obj') return parseObj(bytes, resolveUri);
  if (e === 'stl') return parseStl(bytes);
  if (e === 'ply') return parsePly(bytes);
  if (e === '3mf') return parse3mf(bytes);
  if (e === 'fbx') return parseFbx(bytes);
  if (e === 'dae') return parseDae(bytes);
  if (e === '3ds') return parse3ds(bytes);
  if (e === 'amf') return parseAmf(bytes);
  return parseGltf(bytes, e, resolveUri);
}
export function describeModel(m) {
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const box = m.bounds.size.map((v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))).join(' × ');
  return `${m.label} · ${fmt(m.triangles)} 面 · ${fmt(m.vertices)} 顶点 · 包围盒 ${box}`;
}

// ---------------- 渲染 ----------------

// pitch 是绕 X 轴的俯仰角，正值 = 相机抬高往下看（看到模型顶面、网格铺在脚下）。
// 早期这里写成 -0.34，视线方向朝上，等于把相机放到模型下方，默认一进来就是仰视、
// 地面网格还被翻到物体背后。现在默认给一个 3/4 俯视角，R / F 复位都回到这个角度。
// projection: 'perspective'（默认，针孔相机）| 'orthographic'（正交，f 恒为 1）。
// 正交档是给平面贴图用的：透视下一个平面四边形的四个角投成一般四边形，
// 逐三角仿射贴图会在对角线处错开；正交下整块面是平行四边形，仿射矩阵精确，
// 上下旋转贴图也不会被扭成两半。UI 默认用正交（见 model-view.js），模块台架
// 里的 createView() 仍按透视，保持既有像素对拍用例不变。
// 「原点」按钮画出来的本地坐标轴：X 红 / Y 绿 / Z 蓝，全部从模型自身的枢轴出发
// （物体位置没归零时 ≠ 文件世界原点），见 MeshBuilder.origin / modelOrigin()。
// 轴向量写在归一化后的预览坐标系里（和 model.pos 同一空间），与相机角度无关。
export const ORIGIN_AXES = [
  { label: 'X', dir: [1, 0, 0], color: '#ff3b30' },
  { label: 'Y', dir: [0, 1, 0], color: '#32d74b' },
  { label: 'Z', dir: [0, 0, 1], color: '#0a84ff' },
];

// 模型自身原点（物体枢轴）在预览坐标系里的位置。finish() 已经把解析时记下的节点
// pivot 按同一套 normalize 换算好，直接用；不要再拿 -center*k 去画文件的世界 (0,0,0)——
// 物体位置没归零时那个点会跑到模型外 / 世界中心，正好不是「模型自己的原点」。
// 手搓的 model 对象没有 pivot 信息时按包围盒中心（预览坐标系的 [0,0,0]）兜底。
export function modelOrigin(model) {
  const n = model && model.normalize;
  if (!n) return [0, 0, 0];
  const o = n.origin;
  return Array.isArray(o) && o.length === 3 && o.every(Number.isFinite) ? o.slice() : [0, 0, 0];
}

// 把「物体节点链」的 4x4 变换（列主序，已剥离格式级全局轴 / 单位缩放）拆成
// 位置、三轴缩放、有没有旋转 / 镜像，用来回答模型信息里那三个问题：
//   变换是否已经重置（Apply Transform）、缩放 XYZ 是不是都是 1、坐标是不是在 0 点。
// 缩放取线性部分三列的范数；带剪切 / 非均匀父级时不追求精确还原 TRS，但
// 「是不是 1」「是不是 0」这两个判断依然稳。容差 1e-4 盖住导出器的浮点噪声。
// 参的是节点链矩阵而不是文件世界矩阵，所以 FBX 的 UnitScale=100、Z-up 换轴
// 这类格式级变换不会被误报成「缩放不是 1 / 有旋转」。
const TF_EPS = 1e-4;
export function decomposeTransform(m) {
  if (!m || m.length < 16) return null;
  const a = Array.from(m);
  if (!a.every(Number.isFinite)) return null;
  const translation = [a[12], a[13], a[14]];
  const cols = [[a[0], a[1], a[2]], [a[4], a[5], a[6]], [a[8], a[9], a[10]]];
  const absScale = cols.map((c) => Math.hypot(...c));
  const det =
    cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1]) -
    cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1]) +
    cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
  const mirrored = det < -TF_EPS;
  const degenerate = absScale.some((s) => s < 1e-12);
  // 线性部分只有对角线（允许负号 = 镜像 / 负缩放）时没有旋转；非对角元素一旦出现
  // 就是节点旋转（导出器为 Z-up↔Y-up 加的换轴也会落在这里），如实报出来让用户判断。
  let off = 0;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    if (r === c) continue;
    off = Math.max(off, absScale[c] > 1e-12 ? Math.abs(cols[c][r]) / absScale[c] : Math.abs(cols[c][r]));
  }
  const hasRotation = off > TF_EPS;
  // 纯对角时取带符号对角线，scale = -1 这种镜像不会被列范数吃掉显示成 1；
  // 含旋转时符号不唯一，退回列范数（绝对值），靠 mirrored / hasRotation 补充说明。
  const scale = hasRotation ? absScale.slice() : [a[0], a[5], a[10]];
  const atOrigin = translation.every((v) => Math.abs(v) < TF_EPS);
  const unitScale = !degenerate && !mirrored && scale.every((s) => Math.abs(s - 1) < TF_EPS);
  return {
    translation, scale, det, mirrored, hasRotation, degenerate,
    atOrigin, unitScale,
    reset: atOrigin && unitScale && !hasRotation && !mirrored && !degenerate,
  };
}

export function createView() {
  return { yaw: 0.62, pitch: 0.42, zoom: 1, panX: 0, panY: 0, mode: 'solid',
    spin: false, grid: true, projection: 'perspective', sourceSmoothing: false, showOrigin: false };
}

// 把一个 UV 三角形仿射映射到屏幕三角形：解 3 组 (u,v) → (x,y) 的 2×3 矩阵。
// 画面用的是针孔透视，同一个三角面内 UV 与屏幕并非严格仿射；面越小误差越看不出来，
// 和这套 painter 光栅化的精度是同一量级。返回 null 表示 UV 退化（三点共线）别画。
function texAffine(u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
  const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
  const den = du1 * dv2 - du2 * dv1;
  if (Math.abs(den) < 1e-9) return null;
  const dx1 = x1 - x0, dx2 = x2 - x0, dy1 = y1 - y0, dy2 = y2 - y0;
  const a = (dx1 * dv2 - dx2 * dv1) / den;
  const c = (dx2 * du1 - dx1 * du2) / den;
  const b = (dy1 * dv2 - dy2 * dv1) / den;
  const d = (dy2 * du1 - dy1 * du2) / den;
  return [a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0];
}

// Canvas 2D draws affine images. Subdivide only where the projected UV midpoint
// differs noticeably from the affine midpoint, using homogeneous camera weights.
function drawPerspectiveTexture(ctx, texture, vertices, depth = 0) {
  let edge = 0, maxError = 0;
  for (let i = 0; i < 3; i++) {
    const a = vertices[i], b = vertices[(i + 1) % 3];
    const error = Math.hypot(a.x - b.x, a.y - b.y) * Math.abs(a.w - b.w) / (2 * (a.w + b.w));
    if (error > maxError) { edge = i; maxError = error; }
  }
  const a = vertices[edge], b = vertices[(edge + 1) % 3], c = vertices[(edge + 2) % 3];
  if (maxError > 0.45 && depth < 10) {
    const weight = a.w + b.w;
    const mid = {
      x: (a.x * a.w + b.x * b.w) / weight,
      y: (a.y * a.w + b.y * b.w) / weight,
      w: weight / 2, u: (a.u + b.u) / 2, v: (a.v + b.v) / 2,
    };
    drawPerspectiveTexture(ctx, texture, [a, mid, c], depth + 1);
    drawPerspectiveTexture(ctx, texture, [mid, b, c], depth + 1);
    return;
  }
  const matrix = texAffine(a.u, a.v, b.u, b.v, c.u, c.v, a.x, a.y, b.x, b.y, c.x, c.y);
  if (!matrix) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
  ctx.clip();
  ctx.transform(...matrix);
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}

// 画一帧。ctx 是 2D context，w/h 是 CSS 像素（画布已按 dpr 放大）。
// view 里和 UV 有关的几个可选字段：
//   texture  { canvas, w, h }  已按「黑 → 透明」处理好的贴图
//   uv       Float32Array(6*T) 当前选中通道（已应用旋转 / 镜像）
//   uvWire   true 时用白色把模型线框再描一遍（UV 线框高亮）
//   uvPick / uvPicks  选中的三角面（点选单个 / 框选一批），在模型上高亮成青色
// 返回 { drawn, total, sampled }。
export function renderModel(ctx, model, view, w, h, maxTris = DRAW_FULL) {
  const total = model.triangles;
  const stride = Math.max(1, Math.ceil(total / Math.max(1, maxTris)));
  if (view.bg) { ctx.fillStyle = view.bg; ctx.fillRect(0, 0, w, h); }
  else ctx.clearRect(0, 0, w, h);
  if (!w || !h || !total) return { drawn: 0, total, sampled: stride > 1 };

  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const s = Math.min(w, h) * 0.42 * view.zoom;
  const cx = w / 2 + (view.panX || 0), cyy = h / 2 + (view.panY || 0);
  const pos = model.pos, nrm = model.nrm, col = model.col;
  const L = [-0.36, 0.56, 0.75], LL = Math.hypot(...L);
  const lx = L[0] / LL, ly = L[1] / LL, lz = L[2] / LL;

  // 透视基准：三角面和地面网格必须共用同一个针孔相机。
  // 早期三角面走正交投影、只有网格做透视除法，斜着看一块方形镂空框时，
  // 网格是带消失点的透视地板、框本身却还是平行四边形，两边透视对不上，
  // 看起来就像框被剪切变形了（正顶视时透视几乎不起作用，所以顶视看着正常）。
  const gy = Number.isFinite(model.minY) ? model.minY : -1;   // 模型脚下这层当参考平面
  // 地面是一块有限正方形。半边长按窗口基准比例反推，让它在画面里大致占满一屏；
  // 对 view.zoom 只做平方根级响应：拉远能看到完整的一块地板，推近自然只看到地板一角。
  const s0 = Math.min(w, h) * 0.42;
  const zref = Math.sqrt(Math.max(0.05, view.zoom || 1));
  const G = Math.max(1.2, Math.min(8, 0.46 * Math.min(w, h * 1.25) / (1.5 * s0 * zref)));
  const D = 3.5 * G;                    // 相机到地面中心的距离
  const z2c = sp * gy;                  // 参考平面中心的相机深度，把它处的 f 归一成 1
  const persp = (z2) => D / Math.max(0.4, D + z2c - z2);   // = D / (D - cp*z1)，恒为正
  // 正交档把透视除法整体关掉（f 恒为 1）：模型与地面网格共用同一台相机，
  // 切档不会出现「网格正交、模型还带消失点」的错位。3D 工具条的「正交视图」写这个字段。
  const ortho = view.projection === 'orthographic';
  const focal = ortho ? () => 1 : persp;

  // 地面网格：真·透视投影（针孔相机），不是正交。
  // 之前那版只在正交投影上叠了「距中心越远越淡」，线条依旧互相平行，所以看着还是正交视角。
  // 这里按相机深度做透视除法 f = D / (D - dz)：两组平行线各自收束到自己的消失点，
  // 有限的正方形地面变成一块带边界的四边形 —— 就是参考图里铺在脚下的那块透视地板。
  // 在三角面之前画，模型会把它挡住，网格出现在物体后面 / 脚下。
  if (view.grid) {
    const STEP = G / 12;                  // 24×24 格，格子数不随窗口大小变
    const pG = (x, z) => {
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const y2 = cp * gy - sp * z1;
      const z2 = sp * gy + cp * z1;
      const f = focal(z2);
      return [cx + x1 * s * f, cyy - y2 * s * f, f];
    };
    // 透视投影保持直线：每根网格线只要变换两个端点再连起来，不必细分。
    for (let t = -G; t <= G + 1e-6; t += STEP) {
      const a = pG(-G, t), b = pG(G, t);   // 沿 X 方向的线
      const c = pG(t, -G), d = pG(t, G);   // 沿 Z 方向的线
      // 远处的线稍暗一点，收束到消失点附近时不至于糊成一片
      const al = Math.min(0.4, 0.32 * (0.6 + 0.4 * Math.min(a[2], b[2], c[2], d[2])));
      ctx.strokeStyle = `rgba(124,150,180,${al.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
      ctx.stroke();
    }
    // 有限地面的四条边稍微提亮，一眼看出这块地板的轮廓（参考图里也是带边界的一块）
    ctx.strokeStyle = 'rgba(124,150,180,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const corners = [[-G, -G], [G, -G], [G, G], [-G, G], [-G, -G]];
    for (let i = 0; i < corners.length; i++) {
      const q = pG(corners[i][0], corners[i][1]);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    // 中心十字标出原点，也就是模型脚下
    ctx.strokeStyle = 'rgba(124,224,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const c0 = pG(0, -G * 0.35), c1 = pG(0, G * 0.35);
    ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]);
    const d0 = pG(-G * 0.35, 0), d1 = pG(G * 0.35, 0);
    ctx.moveTo(d0[0], d0[1]); ctx.lineTo(d1[0], d1[1]);
    ctx.stroke();
  }

  // 变换 + 投影到屏幕，顺便记下深度；一次算完避免绘制阶段重复矩阵运算。
  // 三角面和网格一样按相机深度做透视除法，不同深度的面才会有近大远小的收束。
  // 纯线框不吃光照也不吃深度排序（不透明同色线，画的先后不改变画面），这两步整个省掉。
  if ((view.sourceSmoothing || view.vertexNormals) && model.normalPoseDirty) { poseCornerNormals(model); model.normalPoseDirty = false; }
  const mode = view.mode || 'solid';
  const shaded = mode !== 'wire';
  const tex = view.texture || null;
  const uv = view.uv || null;
  const useTex = !!(shaded && tex && tex.canvas && tex.w > 0 && tex.h > 0 && uv);
  const uvWire = !!view.uvWire;
  const uvPick = Number.isInteger(view.uvPick) ? view.uvPick : -1;
  const uvPicks = view.uvPicks instanceof Set ? view.uvPicks
    : (Array.isArray(view.uvPicks) ? new Set(view.uvPicks) : null);
  const isPicked = (i) => (uvPicks ? uvPicks.has(i) : uvPick === i);
  const order = [];
  for (let i = 0; i < total; i += stride) order.push(i);
  const pickCount = uvPicks ? uvPicks.size : uvPick >= 0 ? 1 : 0;
  if (stride > 1 && pickCount) {
    for (const i of uvPicks ?? [uvPick]) {
      if (Number.isInteger(i) && i >= 0 && i < total && i % stride !== 0) order.push(i);
    }
  }
  // Keep point/edge marks visible even if their triangles were not in the preview sample.
  const primitiveMarks = [];
  const markedFaces = stride > 1 ? new Set() : null;
  for (const key of view.uvMarks ?? []) {
    if (key[0] !== 'v' && key[0] !== 'e') continue;
    const mark = parseUvMark(key);
    if (!mark || mark.tri >= total || mark.idx > 2) continue;
    primitiveMarks.push(mark);
    if (markedFaces && mark.tri % stride !== 0 && !isPicked(mark.tri) && !markedFaces.has(mark.tri)) {
      markedFaces.add(mark.tri);
      order.push(mark.tri);
    }
  }
  const px = new Float32Array(total * 3), py = new Float32Array(total * 3);
  const depth = shaded ? new Float32Array(total) : null;
  const depthTest = shaded && (!useTex || tex.opaque === true);
  const texWeights = shaded && !ortho ? new Float32Array(total * 3) : null;
  const vertexDepth = depthTest || view.vertexNormals ? new Float32Array(total * 3) : null;
  let nearest = -Infinity, farthest = Infinity;
  const rn = shaded ? new Float32Array(total * 3) : null;
  for (const i of order) {
    const o = i * 9;
    for (let k = 0; k < 3; k++) {
      const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1;
      const z2 = sp * y + cp * z1;
      const f = focal(z2);
      px[i * 3 + k] = cx + x1 * s * f;
      py[i * 3 + k] = cyy - y2 * s * f;
      if (texWeights) texWeights[i * 3 + k] = 1 / f;
      if (vertexDepth) {
        // Reciprocal camera distance interpolates linearly in screen space.
        const distance = ortho ? z2 : f;
        vertexDepth[i * 3 + k] = distance;
        nearest = Math.max(nearest, distance);
        farthest = Math.min(farthest, distance);
      }
      if (shaded) depth[i] += z2 / 3;
    }
    if (shaded) {
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      const nx1 = cy * nx + sy * nz, nz1 = -sy * nx + cy * nz;
      rn[i * 3] = nx1;
      rn[i * 3 + 1] = cp * ny - sp * nz1;
      rn[i * 3 + 2] = sp * ny + cp * nz1;
    }
  }

  const painterOrder = () => order.sort((a, b) => depth[a] - depth[b]);
  const needsPainterOrder = shaded && (!depthTest || uvWire || mode === 'both' || pickCount > 0);
  if (needsPainterOrder) painterOrder();

  const lighting = (i) => {
    const a = i * 3;
    // 双面着色：abs 让背面也能看清，法线朝哪边都吃同一份光照
    const d = Math.abs(rn[i * 3] * lx + rn[i * 3 + 1] * ly + rn[i * 3 + 2] * lz);
    const shade = 0.34 + 0.66 * d;
    let lights = null;
    if (view.sourceSmoothing && model.sourceNormalMask?.subarray(a, a + 3).some(Boolean)) {
      lights = [0,1,2].map(j => {
        if (!model.sourceNormalMask[a + j]) return shade;
        const o=i*9+j*3, n=model.cornerNrm;
        const x=cy*n[o]+sy*n[o+2], z=-sy*n[o]+cy*n[o+2];
        const y=cp*n[o+1]-sp*z, zz=sp*n[o+1]+cp*z;
        return .34+.66*Math.abs(x*lx+y*ly+zz*lz);
      });
    }
    return { shade, lights };
  };
  const normalLength = view.vertexNormals ? Math.min(.25, 18 / Math.max(s, 1)) * 1.3 : 0;
  if (normalLength) {
    // Leave clip-space room for arrow tips in front of the closest vertex.
    nearest = ortho ? nearest + normalLength : D / Math.max(.4, D / nearest - normalLength);
    farthest = ortho ? farthest - normalLength : D / (D / farthest + normalLength);
  }
  const normalSegments = view.vertexNormals ? function* (frontOnly = false) {
    const groups = new Map();
    const pointDirections = new Map();
    for (const tri of order) {
      const a = tri * 3;
      const facing = (px[a+1] - px[a]) * (py[a+2] - py[a]) - (px[a+2] - px[a]) * (py[a+1] - py[a]);
      const drawable = Math.abs(facing) >= .02 && (!frontOnly || facing < 0);
      for (let j = 0; j < 3; j++) {
        const corner = a + j, offset = corner * 3;
        const x = px[corner], y = py[corner];
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) continue;
        const authored = model.sourceNormalMask?.[corner] && model.cornerNrm;
        const normals = authored ? model.cornerNrm : nrm;
        const n = authored ? offset : a;
        // Merge coincident vertices with matching 3D normals, independently of the camera.
        const pointKey = vectorKey(pos, offset);
        const directionKey = vectorKey(normals, n);
        const firstDirection = pointDirections.get(pointKey);
        if (firstDirection === undefined) pointDirections.set(pointKey, directionKey);
        else if (firstDirection !== null && firstDirection !== directionKey) pointDirections.set(pointKey, null);
        const key = `${pointKey}:${directionKey}`;
        const group = groups.get(key);
        if (group) {
          if (drawable && group.corner < 0) Object.assign(group, {corner, normals, n});
        } else {
          groups.set(key, {corner: drawable ? corner : -1, normals, n, pointKey});
        }
      }
    }
    for (const {corner, normals, n, pointKey} of groups.values()) {
      if (corner < 0) continue;
      const offset = corner * 3;
      const x = px[corner], y = py[corner];
      const tx = pos[offset] + normals[n] * normalLength;
      const ty = pos[offset + 1] + normals[n + 1] * normalLength;
      const tz = pos[offset + 2] + normals[n + 2] * normalLength;
      const z1 = -sy * tx + cy * tz;
      const tipZ = sp * ty + cp * z1;
      const f = focal(tipZ);
      const endX = cx + (cy * tx + sy * tz) * s * f;
      const endY = cyy - (cp * ty - sp * z1) * s * f;
      const dx = endX - x, dy = endY - y, length = Math.hypot(dx, dy);
      if (!Number.isFinite(length)) continue;
      const startDepth = vertexDepth[corner], endDepth = ortho ? tipZ : f;
      const color = Number(pointDirections.get(pointKey) !== null);
      if (length < 1) {
        yield [x - 1, y, startDepth, x + 1, y, startDepth, color];
      } else {
        yield [x, y, startDepth, endX, endY, endDepth, color];
        const head = Math.min(4.5, length * .38) / length;
        const hx = dx * head, hy = dy * head;
        const headDepth = endDepth + (startDepth - endDepth) * head;
        yield [endX - hx + hy * .55, endY - hy - hx * .55, headDepth, endX, endY, endDepth, color];
        yield [endX - hx - hy * .55, endY - hy + hx * .55, headDepth, endX, endY, endDepth, color];
      }
    }
  } : null;
  const uvSeams = view.uvSeams;
  const gpuDrawn = rasterizeModelSurface(ctx, w, h, {
    order, px, py, texWeights, vertexDepth, nearest, farthest, uv, tex: useTex ? tex : null, colors: col, lighting,
    mode, uvWire, uvSeams, isPicked, hasPicks: pickCount > 0, pickCount, depthTest, normalSegments,
  });

  if (gpuDrawn === null && shaded && !needsPainterOrder) painterOrder();
  ctx.lineJoin = 'round';
  ctx.lineWidth = MODEL_LINE_WIDTH;
  if (mode === 'wire') ctx.strokeStyle = WIRE_COLOR;
  else if (mode === 'both') ctx.strokeStyle = 'rgba(124,224,255,0.55)';
  // 线框以前逐三角 stroke()：一帧几万次独立路径光栅化，是线框档卡顿的根源。
  // 现在边攒进 Path2D 每 WIRE_CHUNK 面 stroke 一次：实测 16 面/批最快（逐三角 ~12-17ms、
  // 16 面/批 ~5ms、256 面/批又回到 ~24ms、整帧一次秒级——Skia 对大路径超线性变慢）。
  // 小批量同时保住「近处实体压住远处线框」的深度顺序（批内都是深度相邻的面，误差可忽略）。
  let wirePath = gpuDrawn === null && mode !== 'solid' ? new Path2D() : null;
  let wireTris = 0;
  const flushWire = () => {
    if (!wireTris) return;
    ctx.stroke(wirePath);
    wirePath = new Path2D();
    wireTris = 0;
  };
  // UV 线框是另一层：不挤进几何线框那条路径（颜色 / 线宽都不一样），
  // 同样按 16 面一批 stroke，免得几万面的大路径把 Skia 拖慢
  let uvPath = gpuDrawn === null && uvWire ? new Path2D() : null;
  let seamPath = uvPath && uvSeams ? new Path2D() : null;
  let uvTris = 0;
  const flushUv = () => {
    if (!uvTris) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = MODEL_LINE_WIDTH;
    ctx.stroke(uvPath);
    if (seamPath) {
      ctx.strokeStyle = UV_COLORS.seam;
      ctx.stroke(seamPath);
      seamPath = new Path2D();
    }
    ctx.restore();
    uvPath = new Path2D();
    uvTris = 0;
  };
  let drawn = gpuDrawn ?? 0;
  for (const i of gpuDrawn === null ? order : []) {
    const a = i * 3;
    const x0 = px[a], y0 = py[a], x1 = px[a + 1], y1 = py[a + 1], x2 = px[a + 2], y2 = py[a + 2];
    // 屏幕外的整块三角形不用画
    if ((x0 < -2 && x1 < -2 && x2 < -2) || (x0 > w + 2 && x1 > w + 2 && x2 > w + 2) ||
        (y0 < -2 && y1 < -2 && y2 < -2) || (y0 > h + 2 && y1 > h + 2 && y2 > h + 2)) continue;
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (Math.abs(area) < 0.02) continue;
    if (shaded) {
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath();
      const { shade, lights } = lighting(i);
      const points = lights ? [x0, y0, x1, y1, x2, y2] : null;
      let textured = false;
      if (useTex) {
        const o = i * 6;
        const M = texAffine(
          uv[o] * tex.w, uv[o + 1] * tex.h,
          uv[o + 2] * tex.w, uv[o + 3] * tex.h,
          uv[o + 4] * tex.w, uv[o + 5] * tex.h,
          x0, y0, x1, y1, x2, y2,
        );
        if (M) {
          // clip 到三角面 → 把贴图按 UV 空间的仿射矩阵摆进去 → 一次 drawImage 出一个面。
          // alpha 归零的像素（黑透 / add 渐变里最暗那一档）会直接透出后面的面 / 背景。
          if (texWeights && (texWeights[a] !== texWeights[a + 1] || texWeights[a] !== texWeights[a + 2])) {
            const vertices = [0, 1, 2].map(k => ({ x: px[a + k], y: py[a + k], w: texWeights[a + k],
              u: uv[o + k * 2] * tex.w, v: uv[o + k * 2 + 1] * tex.h }));
            drawPerspectiveTexture(ctx, tex.canvas, vertices);
          } else {
            ctx.save();
            ctx.clip();
            ctx.transform(...M);
            ctx.drawImage(tex.canvas, 0, 0);
            ctx.restore();
          }
          // add 语义（半透明开着）时不再叠这层黑：亮度已经由 alpha 表达，黑处直接
          // 透出后面的面 / 背景、白处保持纯白，和 shader 加色一个观感。普通贴图仍叠
          // 半透明黑保住平面光照的立体感（贴图本身不带明暗）。
          if (!tex.additive) {
            ctx.beginPath();
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath();
            ctx.fillStyle = lights ? shadeGradient(ctx,points,lights,null,true) : `rgba(0,0,0,${((1 - shade) * 0.5).toFixed(3)})`;
            ctx.fill();
          }
          textured = true;
        }
      }
      if (!textured) {
        ctx.fillStyle = lights ? shadeGradient(ctx,points,lights,Array.from(col.subarray(i*3,i*3+3))) : `rgb(${clamp255(col[i * 3] * shade)},${clamp255(col[i * 3 + 1] * shade)},${clamp255(col[i * 3 + 2] * shade)})`;
        ctx.fill();
      }
    }
    if (wirePath) {
      wirePath.moveTo(x0, y0); wirePath.lineTo(x1, y1); wirePath.lineTo(x2, y2); wirePath.closePath();
      wireTris++;
      if (wireTris >= WIRE_CHUNK) flushWire();
    }
    if (uvPath) {
      if (seamPath) {
        for (let edge = 0; edge < 3; edge++) {
          const start = a + edge, end = a + (edge + 1) % 3;
          const path = uvSeams[start] ? seamPath : uvPath;
          path.moveTo(px[start], py[start]); path.lineTo(px[end], py[end]);
        }
      } else {
        uvPath.moveTo(x0, y0); uvPath.lineTo(x1, y1); uvPath.lineTo(x2, y2); uvPath.closePath();
      }
      uvTris++;
      if (uvTris >= WIRE_CHUNK) flushUv();
    }
    // UV 面板里选中一个面（点选）或一批面（框选）：在模型上把对应的那块描成青色
    if (isPicked(i)) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath();
      ctx.fillStyle = 'rgba(124,224,255,0.22)';
      ctx.strokeStyle = '#7ce0ff';
      ctx.lineWidth = 2.2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    drawn++;
  }
  flushWire();
  flushUv();
  // Point/edge marks use a separate overlay and never fill the triangle.
  if (primitiveMarks.length) {
    ctx.save();
    ctx.strokeStyle = UV_COLORS.selection;
    ctx.fillStyle = UV_COLORS.selection;
    ctx.lineWidth = 2.4;
    let points = new Path2D(), edges = new Path2D(), count = 0;
    const flushMarks = () => {
      ctx.fill(points);
      ctx.stroke(edges);
      points = new Path2D();
      edges = new Path2D();
    };
    for (const { kind, tri, idx } of primitiveMarks) {
      const a = tri * 3 + idx, b = tri * 3 + (idx + 1) % 3;
      const x = px[a], y = py[a];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (kind === 'vertex') {
        points.moveTo(x + 3.2, y);
        points.arc(x, y, 3.2, 0, Math.PI * 2);
      } else {
        const x2 = px[b], y2 = py[b];
        if (!Number.isFinite(x2) || !Number.isFinite(y2)) continue;
        edges.moveTo(x, y);
        edges.lineTo(x2, y2);
      }
      if (++count % 512 === 0) flushMarks();
    }
    if (count % 512 !== 0) flushMarks();
    ctx.restore();
  }
  if (gpuDrawn === null && normalSegments) {
    // Canvas fallback still filters back-facing faces using the projected winding.
    ctx.save();
    ctx.lineWidth = .91;
    const paths = NORMAL_ARROW_COLORS.map(() => new Path2D());
    const counts = NORMAL_ARROW_COLORS.map(() => 0);
    const flush = color => {
      ctx.strokeStyle = NORMAL_ARROW_COLORS[color];
      ctx.stroke(paths[color]);
      paths[color] = new Path2D();
      counts[color] = 0;
    };
    for (const [x, y, , endX, endY, , color] of normalSegments(true)) {
      paths[color].moveTo(x, y);
      paths[color].lineTo(endX, endY);
      if (++counts[color] === 512) flush(color);
    }
    counts.forEach((count, color) => { if (count) flush(color); });
    ctx.restore();
  }
  if (view.vertexNumbers) {
    const ids=previewVertices(model.restPos||model.pos), seen=new Set();
    ctx.save();ctx.font='11px "Segoe UI", sans-serif';ctx.textBaseline='bottom';
    ctx.lineWidth=3;ctx.strokeStyle='#151922';ctx.fillStyle='#ffe88a';
    for(let t=0;t<total;t+=stride)for(let j=0;j<3;j++) {
      const i=t*3+j,x=px[i],y=py[i],id=ids[i];
      if(seen.has(id)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>w||y>h)continue;
      seen.add(id);ctx.strokeText(String(id),x+3,y-3);ctx.fillText(String(id),x+3,y-3);
    }
    ctx.restore();
  }
  if (view.showOrigin) {
    // 模型自身枢轴 + XYZ 三色轴。画在整帧最后，作为 gizmo 叠在模型之上：原点哪怕被
    // 模型挡住也看得见，这正是「显示模型自己的原点位置（不是世界中心）」要的效果。
    // 投影和三角面共用同一台相机（cy/sy/cp/sp/s/cx/cyy/focal），角度 / 缩放一起跟着走。
    const [ox, oy, oz] = modelOrigin(model);
    const pAxis = (x, y, z) => {
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1;
      const z2 = sp * y + cp * z1;
      const f = focal(z2);
      return [cx + x1 * s * f, cyy - y2 * s * f];
    };
    const [x0, y0] = pAxis(ox, oy, oz);
    const AXIS_LEN = 1.15;   // 归一化空间：模型最长边 = 2，轴长约等于半边再长一点
    ctx.save();
    ctx.lineCap = 'round';
    // XYZ 字母放大 2 倍（12 → 24px）；轴线比原来细 30%（2.2 → 1.54），
    // 轴线 / 字母 / 原点都不垫深色描边，浅色模型上也是纯净的三色 gizmo。
    ctx.font = 'bold 24px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const axis of ORIGIN_AXES) {
      const [x1, y1] = pAxis(ox + axis.dir[0] * AXIS_LEN,
        oy + axis.dir[1] * AXIS_LEN, oz + axis.dir[2] * AXIS_LEN);
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      ctx.strokeStyle = axis.color;
      ctx.lineWidth = 1.54;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
      // 箭头尺寸放大 2 倍（原 a = min(9, L*0.3)）；字母沿轴再往外挪一个箭头身位，别压住尖头
      const a = L > 6 ? Math.min(18, L * 0.6) : 0;
      if (a > 0) {
        const ux = dx / L, uy = dy / L;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * a + uy * a * 0.5, y1 - uy * a - ux * a * 0.5);
        ctx.lineTo(x1 - ux * a - uy * a * 0.5, y1 - uy * a + ux * a * 0.5);
        ctx.closePath();
        ctx.fillStyle = axis.color;
        ctx.fill();
      }
      const off = a + 10;
      // 字母放大到 24px 后，朝上的 Y 轴标签容易被顶边裁掉：把标签钳回画布内
      // （上下各留 22px、右侧留出字形宽度），轴和箭头仍留在原位不动。
      const lx = Math.max(6, Math.min(w - 28, x1 + (L ? dx / L : 0) * off + 4));
      const ly = Math.max(22, Math.min(h - 22, y1 + (L ? dy / L : 0) * off));
      ctx.fillStyle = axis.color;
      ctx.fillText(axis.label, lx, ly);
    }
    // 原点：只留白心，去掉外圈那道深色描边
    ctx.beginPath(); ctx.arc(x0, y0, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }
  return { drawn, total, sampled: order.length < total };
}

export const RENDER_LIMITS = { full: DRAW_FULL, draft: DRAW_DRAFT, max: MAX_TRIS };

// 缩略图用：把模型按一个固定好看的角度画进任意 canvas，返回这个 canvas
export function renderThumbnail(canvas, model, w, h) {
  canvas.width = Math.max(1, w | 0);
  canvas.height = Math.max(1, h | 0);
  const ctx = canvas.getContext('2d');
  const v = createView();
  v.bg = '#20242c';
  v.zoom = 0.94;
  v.grid = false;
  renderModel(ctx, model, v, canvas.width, canvas.height, 4000);
  return canvas;
}
