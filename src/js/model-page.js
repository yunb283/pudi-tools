// 模型预览页：用 three.js 官方加载器在本地解析 3D 模型，不联网、不上传。
// 格式覆盖面参照 Albedo 的清单（其 NIF 读取器与自研 USDC 解码器属该项目专有代码，未引入）；
// 本文件与 src/vendor/three 下的第三方模块均为 MIT，页面逻辑为本项目自写。
// three.js 版本 0.180.0，裸模块说明符由 index.html 里的 importmap 映射。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  isTauri,
  dirname,
  baseName,
  readEntryBytes,
  pickImages,
  resolveSaveDir,
  saveBlob,
  MODEL_EXTS,
  isModelName,
  isModelAssetName,
} from './platform.js';

const $ = (id) => document.getElementById(id);
const DECODER_ROOT = './vendor/three/addons/libs/';
const MAX_ASSET_FILES = 240;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const CHANNELS = [
  ['shaded', 'PBR 着色'],
  ['albedo', 'Albedo 基础色'],
  ['normal', '法线'],
  ['roughness', '粗糙度'],
  ['metalness', '金属度'],
  ['emissive', '自发光'],
  ['alpha', '不透明度'],
  ['unlit', 'Unlit 无光照'],
  ['wireframe', '线框'],
];

const BACKGROUNDS = {
  dark: 0x1b1d22,
  light: 0xeef0f4,
  blue: 0x2a3648,
};

const state = {
  root: null,       // 外层 pivot，承载居中 / 缩放，不动模型自身的变换
  model: null,      // 加载器返回的原始对象
  original: new Map(),
  generated: [],
  assetUrls: new Map(),
  blobUrls: [],
  name: '',
  ext: '',
  channel: 'shaded',
  bg: 'dark',
  gridVisible: true,
  animations: [],
  mixer: null,
  animPlaying: false,
  quality: 'balanced',
  axesVisible: false,
  boundsVisible: false,
  stats: null,
  baseStatus: '',
  forceWarn: false,
  channelNote: '',
  channelFloor: 0,
  missingAssets: new Set(),
  deadTextures: 0,
  legacyCount: 0,
};

let renderer, scene, camera, controls, manager, grid, axes, bounds, page, stage, canvas;
let loadQueue = Promise.resolve();
let raf = 0;
let needsRender = true;
let lastTime = performance.now();

function setStatus(msg, warn = false) {
  state.baseStatus = msg || '';
  state.forceWarn = !!warn;
  refreshStatus();
}

// 状态行由「载入信息 + 缺失贴图 + 当前通道提示」拼成，切通道时不会互相覆盖
function refreshStatus() {
  const el = $('mv-status');
  if (!el) return;
  const missing = state.missingAssets.size
    ? ` · 缺少 ${state.missingAssets.size} 个外部贴图`
    : '';
  const dead = state.deadTextures
    ? ` · ${state.deadTextures} 个贴图不可用（已剔除，显示材质本色）`
    : '';
  const note = state.channelNote ? ' · ' + state.channelNote : '';
  el.textContent = state.baseStatus + missing + dead + note;
  el.classList.toggle('warn', !!state.forceWarn || !!missing || !!dead || !!state.channelNote);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function toText(bytes) {
  return new TextDecoder().decode(bytes);
}
function extOf(name) {
  return (String(name).split('.').pop() || '').toLowerCase();
}

// ---------- 渲染器 ----------
function initRenderer() {
  page = $('page-model');
  stage = $('mv-stage');
  canvas = $('mv-canvas');

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  camera.position.set(2.4, 1.7, 3.0);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.4;
  controls.addEventListener('change', () => requestRender());

  axes = new THREE.AxesHelper(1.5);
  axes.visible = false;
  scene.add(axes);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404658, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(2, 3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ab6ff, 0.9);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader());
  manager.addHandler(/\.dds$/i, new DDSLoader());
  manager.addHandler(/\.hdr$/i, new RGBELoader());
  manager.addHandler(/\.exr$/i, new EXRLoader());
  manager.onError = (url) => {
    const name = baseName(String(url).split('?')[0]).toLowerCase();
    if (/\.(png|jpe?g|tga|dds|bmp|gif|webp|tiff?|hdr|exr|ktx2?|basis|avif)$/i.test(name)) {
      state.missingAssets.add(name);
    }
    refreshStatus();
  };

  // 初始网格：载入模型后 rebuildGrid() 会按模型尺寸重算
  grid = null;
  rebuildGrid(
    new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    new THREE.Vector3(2, 2, 2)
  );

  new ResizeObserver(() => resize()).observe(stage);
  window.addEventListener('themechange', () => applyBackground(state.bg));
  applyBackground(state.bg);
  resize();
}

function resize() {
  if (!renderer || !stage) return;
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}

function tick() {
  raf = 0;
  if (!page || page.classList.contains('hidden')) return;
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const moved = controls.update(dt);
  if (state.mixer && state.animPlaying) {
    state.mixer.update(dt);
    needsRender = true;
  }
  if (needsRender || moved) {
    renderer.render(scene, camera);
    needsRender = false;
  }
  if (moved || controls.autoRotate || state.animPlaying || needsRender) {
    raf = requestAnimationFrame(tick);
  }
}

function requestRender() {
  needsRender = true;
  if (!raf) raf = requestAnimationFrame(tick);
}

function applyBackground(mode) {
  state.bg = mode;
  if (!renderer) return;
  stage.classList.toggle('mv-checker', mode === 'checker');
  if (mode === 'checker') {
    renderer.setClearColor(0x000000, 0);
  } else {
    renderer.setClearColor(BACKGROUNDS[mode] ?? BACKGROUNDS.dark, 1);
  }
  gridOpacity();
  requestRender();
}

function gridOpacity() {
  if (grid) grid.material.opacity = state.bg === 'light' ? 0.72 : 0.55;
}

// 网格按模型实际尺寸重建：跨度取模型水平宽度的约 5 倍，贴在模型底面下方，
// 线条用中等亮度灰 + 亮青色中心线，避免深色背景上「看不见地面」
function rebuildGrid(fittedBox, fittedSize) {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
    grid = null;
  }
  const footprint = Math.max(fittedSize.x, fittedSize.z, 0.2);
  const cell = footprint / 5;
  const span = Math.max(4, cell * 24);
  grid = new THREE.GridHelper(span, 24, 0x4dd9ff, 0x8792a6);
  grid.position.set(
    (fittedBox.min.x + fittedBox.max.x) / 2,
    fittedBox.min.y - footprint * 0.004,
    (fittedBox.min.z + fittedBox.max.z) / 2
  );
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.material.toneMapped = false;
  grid.renderOrder = -1;
  grid.visible = state.gridVisible;
  gridOpacity();
  scene.add(grid);
  $('mv-grid') && $('mv-grid').classList.toggle('on', grid.visible);
}

// ---------- 外部资源 ----------
function assetKey(url) {
  let s = String(url || '').split('?')[0].split('#')[0];
  try { s = decodeURIComponent(s); } catch (_) { /* 原样用 */ }
  s = s.replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  const rel = parts.slice(-2).join('/').toLowerCase();
  return { last, rel };
}

function clearAssets() {
  for (const u of state.blobUrls) URL.revokeObjectURL(u);
  state.blobUrls = [];
  state.assetUrls.clear();
  state.missingAssets.clear();
  state.deadTextures = 0;
  manager.setURLModifier((url) => url);
}

function registerAssets(assets) {
  clearAssets();
  for (const [key, a] of assets) {
    const url = URL.createObjectURL(new Blob([a.bytes]));
    state.blobUrls.push(url);
    state.assetUrls.set(key.toLowerCase(), url);
  }
  manager.setURLModifier((url) => {
    if (!url) return url;
    if (/^(blob:|data:|https?:|asset:)/i.test(url)) return url;
    const { last, rel } = assetKey(url);
    const hit = state.assetUrls.get(rel) || state.assetUrls.get(last);
    if (hit) return hit;
    // 记录真正被引用但找不到的贴图，状态栏会提示用户
    if (/\.(png|jpe?g|tga|dds|bmp|gif|webp|tiff?|hdr|exr|ktx2?|basis|avif)$/i.test(last)) {
      state.missingAssets.add(last);
    }
    return url;
  });
}

function findAsset(assets, suffix) {
  for (const [key, a] of assets) {
    if (key.toLowerCase().endsWith(suffix)) return a;
  }
  return null;
}

// 从模型字节里抽出被引用的文件名（FBX 二进制里贴图名也是明文），
// 只读取真正可能被用到的同目录资源，避免把文件夹里几十 MB 无关图片全灌进内存
const REF_EXT = '(?:png|jpe?g|tga|dds|bmp|gif|webp|tiff?|hdr|exr|ktx2?|basis|bin|mtl|usd[ac]?|gltf|obj|json|mtlx)';
const REF_TOKEN_RE = new RegExp('[A-Za-z0-9_.\\-]+\\.' + REF_EXT, 'gi');
const REF_QUOTED_RE = new RegExp('["\']([^"\'\r\n]{0,120}\\.' + REF_EXT + ')["\']', 'gi');
function referencedNames(bytes) {
  const out = new Set();
  const head = bytes.subarray(0, Math.min(bytes.length, 8 * 1024 * 1024));
  const text = new TextDecoder('latin1').decode(head);
  let m;
  REF_TOKEN_RE.lastIndex = 0;
  while ((m = REF_TOKEN_RE.exec(text))) out.add(baseName(m[0]).toLowerCase());
  // 引号里的路径可能带空格（"textures/my tex.png"），单独补一遍
  REF_QUOTED_RE.lastIndex = 0;
  while ((m = REF_QUOTED_RE.exec(text))) out.add(baseName(m[1].trim()).toLowerCase());
  return out;
}

// Tauri 下把模型旁边的贴图 / .bin / .mtl 一并读进来；浏览器里用多选的文件代替
async function collectAssets(entry, siblings = [], bytes = null) {
  const out = new Map();
  const put = (name, bytes) => {
    if (!bytes || !bytes.length) return;
    const key = baseName(name).toLowerCase();
    if (!out.has(key)) out.set(key, { name: baseName(name), bytes });
  };

  for (const s of siblings) {
    if (!s || s === entry || !isModelAssetName(s.name)) continue;
    try { put(s.name, await readEntryBytes(s)); } catch (_) { /* 单个资源失败不中断 */ }
  }

  if (!isTauri || !entry.path) return out;
  const dir = dirname(entry.path);
  if (!dir) return out;
  let files = [];
  try {
    files = (await window.__TAURI__.core.invoke('list_files', { dir })) || [];
  } catch (_) {
    return out;
  }
  const refs = bytes ? referencedNames(bytes) : new Set();
  const candidates = files
    .filter((p) => isModelAssetName(p) && (!refs.size || refs.has(baseName(p).toLowerCase())))
    .slice(0, MAX_ASSET_FILES);
  for (const p of candidates) {
    try {
      const size = await window.__TAURI__.core.invoke('file_size', { path: p });
      if (size > MAX_ASSET_BYTES) continue;
      put(p, await readEntryBytes({ name: baseName(p), path: p }));
    } catch (_) { /* 跳过读不了的 */ }
  }
  return out;
}

// ---------- 加载器 ----------
function setupGLTF(loader) {
  // 三个解码器各自独立：某个初始化不了（比如显卡不支持 KTX2 转码）不能连普通 GLB 都打不开
  try {
    loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath(DECODER_ROOT + 'draco/gltf/'));
  } catch (err) {
    console.warn('[model-page] Draco 解码器不可用', err);
  }
  try {
    const ktx2 = new KTX2Loader(manager)
      .setTranscoderPath(DECODER_ROOT + 'basis/')
      .detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  } catch (err) {
    console.warn('[model-page] KTX2 解码器不可用', err);
  }
  try {
    loader.setMeshoptDecoder(MeshoptDecoder);
  } catch (err) {
    console.warn('[model-page] Meshopt 解码器不可用', err);
  }
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xc9cdd4,
    roughness: 0.65,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
}

// 各加载器返回值不统一：Object3D / {scene} / BufferGeometry / {meshes} 都收成 Object3D
function normalizeResult(res) {
  if (!res) throw new Error('加载器没有返回结果');
  if (res.isObject3D) return res;
  if (res.scene && res.scene.isObject3D) return res.scene;
  if (res.isBufferGeometry) return new THREE.Mesh(res, defaultMaterial());
  if (res.geometry && res.geometry.isBufferGeometry) {
    return new THREE.Mesh(res.geometry, res.material || defaultMaterial());
  }
  if (Array.isArray(res.meshes)) {
    const g = new THREE.Group();
    for (const m of res.meshes) if (m && m.isObject3D) g.add(m);
    if (g.children.length) return g;
  }
  if (Array.isArray(res)) {
    const g = new THREE.Group();
    for (const m of res) if (m && m.isObject3D) g.add(m);
    if (g.children.length) return g;
  }
  throw new Error('无法识别的解析结果');
}

async function parseModel(bytes, ext, assets) {
  const text = () => toText(bytes);
  const buf = () => toArrayBuffer(bytes);
  const load = (p) => import(p);

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await load('three/addons/loaders/GLTFLoader.js');
      const l = new GLTFLoader(manager);
      setupGLTF(l);
      const gltf = await new Promise((resolve, reject) => {
        l.parse(ext === 'gltf' ? text() : buf(), '', resolve, reject);
      });
      state.animations = gltf.animations || [];
      return gltf.scene;
    }
    case 'obj': {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        load('three/addons/loaders/OBJLoader.js'),
        load('three/addons/loaders/MTLLoader.js'),
      ]);
      const l = new OBJLoader(manager);
      const mtl = findAsset(assets, '.mtl');
      if (mtl) {
        try {
          const mats = new MTLLoader(manager).parse(toText(mtl.bytes), '');
          mats.preload();
          l.setMaterials(mats);
        } catch (_) { /* MTL 坏了也照样看几何 */ }
      }
      return l.parse(text());
    }
    case 'fbx': {
      const { FBXLoader } = await load('three/addons/loaders/FBXLoader.js');
      const res = new FBXLoader(manager).parse(buf(), '');
      state.animations = (res.animations || []).slice();
      return res;
    }
    case 'stl': {
      const { STLLoader } = await load('three/addons/loaders/STLLoader.js');
      return new STLLoader().parse(buf());
    }
    case 'ply': {
      const { PLYLoader } = await load('three/addons/loaders/PLYLoader.js');
      return new PLYLoader().parse(buf());
    }
    case 'dae': {
      const { ColladaLoader } = await load('three/addons/loaders/ColladaLoader.js');
      return new ColladaLoader(manager).parse(text(), '');
    }
    case '3mf': {
      const { ThreeMFLoader } = await load('three/addons/loaders/3MFLoader.js');
      return new ThreeMFLoader(manager).parse(buf());
    }
    case '3ds': {
      const { TDSLoader } = await load('three/addons/loaders/TDSLoader.js');
      return new TDSLoader(manager).parse(buf(), '');
    }
    case 'wrl':
    case 'vrml': {
      const { VRMLLoader } = await load('three/addons/loaders/VRMLLoader.js');
      return new VRMLLoader(manager).parse(text(), '');
    }
    case 'vox': {
      const { VOXLoader } = await load('three/addons/loaders/VOXLoader.js');
      return new VOXLoader().parse(buf());
    }
    case 'amf': {
      const { AMFLoader } = await load('three/addons/loaders/AMFLoader.js');
      return new AMFLoader(manager).parse(buf());
    }
    case 'pcd': {
      const { PCDLoader } = await load('three/addons/loaders/PCDLoader.js');
      return new PCDLoader().parse(buf());
    }
    case 'xyz': {
      const { XYZLoader } = await load('three/addons/loaders/XYZLoader.js');
      return new XYZLoader().parse(text());
    }
    case 'usd':
    case 'usda':
    case 'usdc':
    case 'usdz': {
      const { USDLoader } = await load('three/addons/loaders/USDLoader.js');
      const l = new USDLoader(manager);
      return ext === 'usd' || ext === 'usda' ? l.parse(text()) : l.parse(buf());
    }
    case 'kmz': {
      const { KMZLoader } = await load('three/addons/loaders/KMZLoader.js');
      return new KMZLoader(manager).parse(buf());
    }
    case 'lwo': {
      const { LWOLoader } = await load('three/addons/loaders/LWOLoader.js');
      return new LWOLoader(manager).parse(buf());
    }
    case 'md2': {
      const { MD2Loader } = await load('three/addons/loaders/MD2Loader.js');
      return new MD2Loader().parse(buf());
    }
    case 'gcode': {
      const { GCodeLoader } = await load('three/addons/loaders/GCodeLoader.js');
      return new GCodeLoader().parse(text());
    }
    case 'vtk': {
      const { VTKLoader } = await load('three/addons/loaders/VTKLoader.js');
      return new VTKLoader().parse(buf());
    }
    default:
      throw new Error('暂不支持 .' + ext + ' 格式');
  }
}

// ---------- 材质修复 ----------
// 贴图加载失败时，three.js 会留下一个没有像素数据的空贴图，采样结果就是纯黑。
// ImageLoader 用 <img>，DataTextureLoader / CompressedTextureLoader 用 image.data / mipmaps。
function textureHasPixels(tex) {
  const im = tex && tex.image;
  if (!im) return false;
  if (tex.isCompressedTexture) return !!(tex.mipmaps && tex.mipmaps.length);
  if (Array.isArray(im)) {
    // CubeTexture / 贴图数组
    return im.length > 0 && im.every((x) => x && (x.width || (x.complete && x.naturalWidth) || x.data));
  }
  if (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement) {
    return im.complete && im.naturalWidth > 0;
  }
  if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) return true;
  if (im.data !== undefined) return !!im.data && im.data.length > 0;
  return !!(im.width && im.height);
}

// 等所有外部资源（含 404 失败）都结束后再检查贴图，避免把「还在下载」误判成失败
function settleTextures(isIdle, limit = 1500) {
  if (isIdle()) return Promise.resolve();
  return new Promise((resolve) => {
    const prevLoad = manager.onLoad;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      manager.onLoad = prevLoad;
      resolve();
    };
    const timer = setTimeout(finish, limit);
    const poll = setInterval(() => { if (isIdle()) finish(); }, 30);
    manager.onLoad = () => finish();
  });
}

function rescueMaterials(root) {
  const seen = new Set();
  let legacy = 0;
  let dead = 0;
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const isLegacy = !!(m.isMeshPhongMaterial || m.isMeshLambertMaterial ||
        m.isMeshBasicMaterial || m.isMeshToonMaterial);
      if (isLegacy) legacy++;
      m.userData.mvLegacy = isLegacy;
      let changed = false;
      for (const k of MAP_KEYS) {
        const t = m[k];
        if (t && t.isTexture && !textureHasPixels(t)) {
          m[k] = null;   // 空贴图会把整个材质染黑，去掉后退回材质本色
          dead++;
          changed = true;
        }
      }
      // FBX / OBJ 等老格式常见 DiffuseColor=(0,0,0) + 贴图负责颜色；
      // 贴图缺失或颜色本身是纯黑时，给一个中性色，避免模型变成一团黑影
      if (m.color) {
        const c = m.color;
        const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        if (lum < 0.045) {
          c.setHex(m.map ? 0xffffff : 0xc9cdd4);
          changed = true;
        }
      }
      if (changed) m.needsUpdate = true;
    }
  });
  state.legacyCount = legacy;
  state.deadTextures = dead;
}

// ---------- 检查通道 ----------
function gray(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  return new THREE.Color(n, n, n);
}

function channelMaterial(mode, orig, obj) {
  if (mode === 'shaded') return orig;
  if ((obj.isPoints || obj.isLine) && mode !== 'wireframe') return orig;
  const base = Array.isArray(orig) ? orig[0] : orig;
  const m = base || {};
  let mat;
  switch (mode) {
    case 'albedo':
      mat = new THREE.MeshBasicMaterial({
        color: m.color ? m.color.clone() : new THREE.Color(0xcccccc),
        map: m.map || null,
        vertexColors: !!m.vertexColors,
        side: THREE.DoubleSide,
      });
      break;
    case 'unlit':
      mat = new THREE.MeshBasicMaterial({
        color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        map: m.map || null,
        vertexColors: !!m.vertexColors,
        side: THREE.DoubleSide,
        transparent: !!m.transparent,
        opacity: typeof m.opacity === 'number' ? m.opacity : 1,
      });
      break;
    case 'normal':
      mat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, flatShading: false });
      break;
    case 'wireframe':
      mat = new THREE.MeshBasicMaterial({ color: 0x4dd9ff, wireframe: true });
      break;
    case 'roughness':
      // Phong / Lambert 没有 PBR 参数，用中性灰占位，别让模型整块变黑
      mat = new THREE.MeshBasicMaterial({
        color: m.userData?.mvLegacy
          ? gray(0.42)
          : gray(Math.max(typeof m.roughness === 'number' ? 1 - m.roughness : 0.5, state.channelFloor || 0)),
        side: THREE.DoubleSide,
      });
      break;
    case 'metalness':
      mat = new THREE.MeshBasicMaterial({
        color: m.userData?.mvLegacy
          ? gray(0.42)
          : gray(Math.max(typeof m.metalness === 'number' ? m.metalness : 0, state.channelFloor || 0)),
        side: THREE.DoubleSide,
      });
      break;
    case 'emissive':
      mat = new THREE.MeshBasicMaterial({
        color: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
        map: m.emissiveMap || null,
        side: THREE.DoubleSide,
      });
      break;
    case 'alpha':
      mat = new THREE.MeshBasicMaterial({ color: gray(typeof m.opacity === 'number' ? m.opacity : 1), side: THREE.DoubleSide });
      break;
    default:
      mat = orig;
  }
  if (mat !== orig) state.generated.push(mat);
  return mat;
}

// 判断某个通道对当前模型有没有实际数据，并给出提示文案
function channelStats(mode) {
  const out = { total: 0, legacy: 0, min: Infinity, max: -Infinity };
  if (!state.root) return out;
  const read = (m) => {
    if (!m) return;
    out.total++;
    if (m.userData?.mvLegacy) { out.legacy++; return; }
    let v = null;
    if (mode === 'metalness' && typeof m.metalness === 'number') v = m.metalness;
    if (mode === 'roughness' && typeof m.roughness === 'number') v = m.roughness;
    if (v !== null) { out.min = Math.min(out.min, v); out.max = Math.max(out.max, v); }
  };
  state.root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const orig = state.original.get(o) || o.material;
    for (const m of (Array.isArray(orig) ? orig : [orig])) read(m);
  });
  return out;
}

function applyChannel(mode) {
  state.channel = mode;
  state.channelFloor = 0;
  state.channelNote = '';
  $('mv-wire').classList.toggle('on', mode === 'wireframe');
  if (state.root) {
    const st = channelStats(mode);
    const label = { metalness: '金属度', roughness: '粗糙度' }[mode];
    if (label && st.total) {
      if (st.legacy === st.total) {
        state.channelNote = `该模型是 Phong / Lambert 材质，无${label}数据，显示占位灰`;
      } else if (st.max - st.min < 0.001 && st.min <= 0.001) {
        state.channelNote = `该模型${label}全为 0（非金属），已略微提亮便于观察`;
        state.channelFloor = 0.12;
      }
    }
    for (const m of state.generated) m.dispose();
    state.generated = [];
    state.root.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine) return;
      if (!state.original.has(o)) state.original.set(o, o.material);
      const orig = state.original.get(o);
      const list = Array.isArray(orig) ? orig : [orig];
      const next = list.map((m) => channelMaterial(mode, m, o));
      o.material = Array.isArray(orig) ? next : next[0];
    });
  }
  refreshStatus();
  requestRender();
}

// ---------- 统计 ----------
const MAP_KEYS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap', 'specularMap',
];

function inspect(root, rawSize) {
  const mats = new Set();
  const textures = new Set();
  let meshes = 0, triangles = 0, vertices = 0, bones = 0, points = 0;
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) bones += o.skeleton.bones.length;
    if (o.isPoints) points += (o.geometry?.attributes?.position?.count || 0);
    if (!o.isMesh || !o.geometry) return;
    meshes += 1;
    const g = o.geometry;
    vertices += g.attributes?.position?.count || 0;
    triangles += g.index ? g.index.count / 3 : (g.attributes?.position?.count || 0) / 3;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      mats.add(m);
      for (const k of MAP_KEYS) if (m[k] && m[k].isTexture) textures.add(m[k].uuid);
    }
  });
  return {
    meshes, triangles: Math.round(triangles), vertices, points, bones,
    materials: mats.size, textures: textures.size,
    animations: state.animations.length,
    size: rawSize,
    materialList: [...mats].slice(0, 24).map((m) => ({
      name: m.name || '(未命名)',
      type: m.type || 'Material',
      color: m.color ? '#' + m.color.getHexString() : '-',
      maps: MAP_KEYS.filter((k) => m[k] && m[k].isTexture).length,
    })),
  };
}

function renderInfo() {
  const s = state.stats;
  const statsEl = $('mv-stats');
  const matEl = $('mv-materials');
  if (!s) {
    statsEl.innerHTML = '<span class="dim-label">还没有载入模型</span>';
    matEl.innerHTML = '<span class="dim-label">-</span>';
    return;
  }
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const rows = [
    ['网格', fmt(s.meshes)],
    ['三角面', fmt(s.triangles)],
    ['顶点', fmt(s.vertices)],
    ['点云顶点', fmt(s.points)],
    ['骨骼', fmt(s.bones)],
    ['材质', fmt(s.materials)],
    ['贴图', fmt(s.textures)],
    ['动画', fmt(s.animations)],
    ['原始尺寸', s.size],
  ];
  statsEl.innerHTML = rows.map(([k, v]) =>
    `<div class="mv-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`
  ).join('');
  matEl.innerHTML = s.materialList.length
    ? s.materialList.map((m) =>
        `<div class="mv-mat"><span class="mv-swatch" style="background:${esc(m.color)}"></span>` +
        `<span class="mv-matname">${esc(m.name)}</span>` +
        `<span class="dim-label">${esc(m.type)} · ${m.maps} 贴图</span></div>`
      ).join('')
    : '<span class="dim-label">没有材质</span>';
}

// ---------- 模型生命周期 ----------
function disposeRoot() {
  if (!state.root) return;
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  state.root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    const list = Array.isArray(o.material) ? [...o.material] : [o.material];
    const originals = state.original.get(o);
    if (originals) list.push(...(Array.isArray(originals) ? originals : [originals]));
    for (const m of list) {
      if (!m) continue;
      mats.add(m);
      for (const k of MAP_KEYS) if (m[k] && m[k].isTexture) texs.add(m[k]);
    }
  });
  for (const m of state.generated) mats.add(m);
  for (const m of mats) m.dispose();
  for (const t of texs) t.dispose();
  for (const g of geos) g.dispose();
  scene.remove(state.root);
  if (bounds) { scene.remove(bounds); bounds.geometry.dispose(); bounds.material.dispose(); bounds = null; }
  state.root = null;
  state.model = null;
  state.legacyCount = 0;
  state.mixer = null;
  state.animations = [];
  state.original.clear();
  state.generated = [];
  state.stats = null;
}

function fitModel(pivot) {
  // 只动外层 pivot：模型根节点自带的 -90° 旋转 / 100 倍单位原样保留，
  // 之前直接改 root.position / root.scale 会让居中和缩放互相干扰，网格也对不上地面
  pivot.position.set(0, 0, 0);
  pivot.scale.setScalar(1);
  pivot.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const raw = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = 2 / maxDim;
  pivot.scale.setScalar(s);
  pivot.position.set(-center.x * s, -center.y * s, -center.z * s);
  pivot.updateWorldMatrix(true, true);
  const fitted = box.clone();
  fitted.min.multiplyScalar(s).add(pivot.position);
  fitted.max.multiplyScalar(s).add(pivot.position);
  rebuildGrid(fitted, fitted.getSize(new THREE.Vector3()));
  controls.target.set(0, 0, 0);
  camera.position.set(2.4, 1.7, 3.0);
  camera.near = 0.01;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  controls.update();
  return raw;
}

async function loadEntry(entry, siblings = []) {
  if (!entry) return;
  const ext = extOf(entry.name);
  if (!isModelName(entry.name)) {
    setStatus('不是支持的 3D 格式：' + entry.name, true);
    return;
  }
  setStatus('正在读取 ' + entry.name + ' …');
  // 贴图是异步加载的：统计本次解析发起的资源请求，等全部结束（含 404）再修材质
  const rawStart = manager.itemStart;
  const rawEnd = manager.itemEnd;
  const rawLoad = manager.onLoad;
  let pending = 0;
  const previousAnimations = state.animations;
  try {
    const bytes = await readEntryBytes(entry);
    if (!bytes || !bytes.length) throw new Error('文件内容为空');
    const assets = await collectAssets(entry, siblings, bytes);
    registerAssets(assets);
    setStatus('正在解析 .' + ext + ' …');
    manager.itemStart = (url) => { pending++; return rawStart(url); };
    manager.itemEnd = (url) => { pending = Math.max(0, pending - 1); return rawEnd(url); };
    let result;
    try {
      state.animations = [];
      result = await parseModel(bytes, ext, assets);
      await settleTextures(() => pending === 0);
    } finally {
      manager.itemStart = rawStart;
      manager.itemEnd = rawEnd;
      manager.onLoad = rawLoad;
    }
    const model = normalizeResult(result);
    const animations = state.animations.slice();

    // 空贴图 / 纯黑 DiffuseColor 会让模型变成一团黑影，先修好再进视口
    rescueMaterials(model);

    const pivot = new THREE.Group();
    pivot.add(model);
    disposeRoot();
    state.root = pivot;
    state.model = model;
    state.animations = animations;
    scene.add(pivot);
    const rawSize = fitModel(pivot);
    state.stats = inspect(pivot, rawSize);
    bounds = new THREE.BoxHelper(pivot, 0xffc857);
    bounds.visible = state.boundsVisible;
    scene.add(bounds);
    const clipSelect = $('mv-clip');
    clipSelect.innerHTML = state.animations.map((clip, i) => `<option value="${i}">${esc(clip.name || '动画 ' + (i + 1))}</option>`).join('');
    clipSelect.disabled = !state.animations.length;
    if (state.animations.length) {
      state.mixer = new THREE.AnimationMixer(model);
      state.mixer.clipAction(state.animations[0]).play();
      state.animPlaying = true;
    } else {
      state.animPlaying = false;
    }
    $('mv-anim').disabled = !state.animations.length;
    $('mv-anim').classList.toggle('on', state.animPlaying);
    $('mv-anim').textContent = state.animPlaying ? '暂停动画' : '播放动画';
    state.name = entry.name;
    state.ext = ext;
    $('mv-hint').hidden = true;
    $('mv-file').textContent = entry.name;
    // 换模型时回到默认着色视图，避免上次停留的金属度 / 粗糙度通道把新模型显示成全黑
    state.channel = 'shaded';
    $('mv-channel').value = 'shaded';
    applyChannel('shaded');
    renderInfo();
    resize();
    const missing = [];
    if (ext === 'obj' && !findAsset(assets, '.mtl')) missing.push('未找到 .mtl');
    setStatus(
      `已载入 ${entry.name} · ${state.stats.triangles.toLocaleString('zh-CN')} 三角面` +
      (missing.length ? ' · ' + missing.join('、') : '')
    );
  } catch (err) {
    state.animations = previousAnimations;
    console.error('[model-page]', err);
    setStatus('载入失败：' + (err?.message || String(err)), true);
  } finally {
    manager.itemStart = rawStart;
    manager.itemEnd = rawEnd;
    manager.onLoad = rawLoad;
  }
}

// ---------- 控件 ----------
function bindControls() {
  $('mv-open').addEventListener('click', async () => {
    const entries = await pickImages(true, MODEL_EXTS, {
      title: '选择 3D 模型（可同时选中旁边的贴图 / .bin / .mtl）',
      label: '3D 模型',
    });
    if (!entries.length) return;
    const main = entries.find((e) => isModelName(e.name)) || entries[0];
    queueLoad(main, entries.filter((e) => e !== main));
  });

  $('mv-reset').addEventListener('click', () => {
    if (state.root) fitModel(state.root);
    $('mv-view').value = 'iso';
    requestRender();
  });

  $('mv-quality').addEventListener('change', (e) => {
    state.quality = e.target.value;
    const cap = { performance: 1, balanced: 1.5, high: 2 }[state.quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    resize();
  });
  $('mv-view').addEventListener('change', (e) => {
    const directions = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.001], iso: [2.4, 1.7, 3] };
    const direction = directions[e.target.value];
    if (!direction) return;
    const distance = Math.max(camera.position.distanceTo(controls.target), 0.1);
    camera.position.copy(controls.target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(distance));
    controls.update();
    requestRender();
  });
  $('mv-axes').addEventListener('click', (e) => {
    state.axesVisible = !state.axesVisible; axes.visible = state.axesVisible;
    e.currentTarget.classList.toggle('on', state.axesVisible); requestRender();
  });
  $('mv-bounds').addEventListener('click', (e) => {
    state.boundsVisible = !state.boundsVisible; if (bounds) bounds.visible = state.boundsVisible;
    e.currentTarget.classList.toggle('on', state.boundsVisible); requestRender();
  });
  $('mv-clip').addEventListener('change', (e) => {
    if (!state.mixer) return;
    state.mixer.stopAllAction();
    state.mixer.clipAction(state.animations[Number(e.target.value)]).play();
    state.mixer.update(0); requestRender();
  });

  $('mv-channel').addEventListener('change', (e) => applyChannel(e.target.value));
  $('mv-bg').addEventListener('change', (e) => applyBackground(e.target.value));

  $('mv-wire').addEventListener('click', (e) => {
    const on = state.channel !== 'wireframe';
    $('mv-channel').value = on ? 'wireframe' : 'shaded';
    applyChannel(on ? 'wireframe' : 'shaded');
    e.currentTarget.classList.toggle('on', on);
  });

  $('mv-grid').addEventListener('click', (e) => {
    state.gridVisible = !state.gridVisible;
    grid.visible = state.gridVisible;
    e.currentTarget.classList.toggle('on', state.gridVisible);
    requestRender();
  });

  $('mv-rotate').addEventListener('click', (e) => {
    controls.autoRotate = !controls.autoRotate;
    e.currentTarget.classList.toggle('on', controls.autoRotate);
    requestRender();
  });

  $('mv-anim').addEventListener('click', (e) => {
    if (!state.mixer) return;
    state.animPlaying = !state.animPlaying;
    e.currentTarget.classList.toggle('on', state.animPlaying);
    e.currentTarget.textContent = state.animPlaying ? '暂停动画' : '播放动画';
    lastTime = performance.now();
    requestRender();
  });

  $('mv-shot').addEventListener('click', async () => {
    if (!state.root) {
      setStatus('先载入一个模型再导出截图', true);
      return;
    }
    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL('image/png');
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stem = state.name.replace(/\.[^.]*$/, '') || 'model';
    const dir = await resolveSaveDir(null);
    if (isTauri && !dir) return;
    const saved = await saveBlob(stem + '-preview.png', bytes, dir);
    setStatus(saved ? '截图已导出：' + saved : '截图已取消');
  });
}

function queueLoad(entry, siblings = []) {
  loadQueue = loadQueue.then(() => loadEntry(entry, siblings));
  return loadQueue;
}

export function initModelPage() {
  const help = $('mv-help');
  $('mv-help-formats').textContent = MODEL_EXTS.map((ext) => '.' + ext).join('、');
  $('mv-help-open').addEventListener('click', () => help.showModal());

  try {
    initRenderer();
    bindControls();
    $('mv-channel').innerHTML = CHANNELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
    $('mv-grid').classList.add('on');
    $('mv-hint').hidden = false;
    renderInfo();
    return {
      redraw: () => resize(),
      loadEntry: queueLoad,
    };
  } catch (err) {
    // WebGL 起不来不能把整个工具箱拖垮：这一页降级成提示，其它页照常可用
    console.error('[model-page] 3D 视口初始化失败', err);
    $('mv-hint').textContent = '当前环境无法创建 WebGL 视口';
    setStatus('3D 视口不可用：' + (err?.message || String(err)), true);
    return {
      redraw() {},
      loadEntry: () => setStatus('当前环境无法预览 3D 模型', true),
    };
  }
}
