// 迁移自 pudi-view 的 3D 预览层，使用工具箱的面板和文件操作。
import { uvSeamFlags } from './model-topology.js';

import {
  parseModel, renderModel, createView, RENDER_LIMITS,
  applyModelAnimation, resetModelPose, useAnimationTake,
} from './model3d.js';
import {
  DEFAULT_UV_STATE, transformUv, makeTexture, drawUvLayout,
  pickUvElement, pickUvElementsInRect, uvMarkKey, uvIslandTriangles, parseUvMark,
  pickUvTriangle, pickUvTrianglesInRect, uvLayoutView, UV_DEFAULT_ZOOM, UV_MIN_ZOOM, UV_COLORS,
} from './model-uv.js';

export function createModelView({ canvas, bar, animBar, stage, info, buttons, viewSelect, viewportTools,
  uvBar = null, uvPanel = null, uvControls = {},
  onImportTexture, onExportUv,
  animControls, isVisible }) {
  let model = null;
  // 默认视角按「滚轮向后滚 4 格」拉远：滚轮步进是 view.zoom *= exp(-dy * 0.0014)，
  // Chromium 每格 deltaY=100，4 格即 exp(-0.56) ≈ 0.571。复位 / 重开都回到这档。
  const DEFAULT_ZOOM = Math.exp(-0.0014 * 100 * 4);
  // 交互档只降像素、不抽面：画布按 0.65 倍分辨率渲染，CSS 再拉回原尺寸。
  const DRAFT_SCALE = 0.65;

  let view = createView();
  view.zoom = DEFAULT_ZOOM;
  view.projection = 'perspective';
  let active = false;
  let raf = 0;
  let idleTimer = 0;
  let draft = false;
  // FBX 节点动画的播放时基：和「自动旋转」是两个独立时基，可以叠在一起跑
  let playing = false, animTime = 0, animStamp = 0;
  let animUnit = 'frames';   // 'frames'（默认显示帧号）| 'seconds'（切换到秒）
  let drag = null;

  // ---- UV / 贴图：3D 专用工具栏的整套状态，和图片工具栏互不往来 ----
  let uvState = { ...DEFAULT_UV_STATE };   // 预览与导出吃同一份；界面已不再暴露旋转 / 镜像，底层仍认这些字段
  let uvSetIndex = 0;
  let uvWireOn = false;                    // 模型上的 UV 线框高亮
  let uvPanelOn = false;
  let uvPick = -1;                         // 点选的那一个三角面
  let uvPicks = new Set();                 // 选中的一批面（点选 1 个 / 框选多个），模型上一起高亮
  let uvZoom = UV_DEFAULT_ZOOM;                          // UV 展开图的滚轮缩放倍数
  let uvCenter = { u: 0.5, v: 0.5 };      // 缩放 / 平移中心（UV 空间），滚轮按鼠标位置挪它
  let uvBox = null;                        // 正在框选的矩形（画布像素）
  // 左键拖拽默认平移画布，按住 Shift 才是框选；单击（没移动）仍是点选元素。
  let uvSelDrag = null;                    // { mode:'pan'|'select', c0, x0,y0,x1,y1, moved }
  let uvGripDrag = null;                   // UV 窗口左下角的尺寸拖拽
  const UV_CANVAS_MIN = 160, UV_CANVAS_DEFAULT = 260, UV_CANVAS_MAX = 560;
  const uvSizeKey = 'pudi.modelUvCanvasSize';
  let uvPreferredSize = null;
  try {
    const saved = Number(localStorage.getItem(uvSizeKey));
    if (Number.isFinite(saved) && saved >= UV_CANVAS_MIN && saved <= UV_CANVAS_MAX) uvPreferredSize = saved;
  } catch (_) {}

  function rememberUvSize(size) {
    uvPreferredSize = size;
    try { localStorage.setItem(uvSizeKey, String(size)); } catch (_) {}
  }
  let uvMessageTimer;
  let uvBitmap = null;                     // 原始 ImageBitmap
  let texture = null;                      // 处理过半透明 / 黑透的贴图 canvas
  let textureName = '';
  let modelName = '';                      // 当前模型文件名，给「模型信息」窗口用
  let semiOn = false;                      // 半透明按钮：没指定贴图时禁用，按下即 100% 亮度渐变
  // 默认透视：透视下平面贴图上下旋转时会沿对角线略扭（仿射逐三角贴图在一般
  // 四边形上不精确），但保留原模型的立体纵深；想要平面贴图不扭曲时按「正交视图」
  // 按钮切过去，正交下整块面是平行四边形，仿射矩阵精确，贴图不再扭。
  let projection = 'perspective';
  let uvElement = 'edge';                  // 元素选择：vertex 点 / edge 线 / face 面 / island 整块 UV，默认线
  let uvMarks = new Set();                 // 选中的元素标记（'v:t:j' / 'e:t:j' / 'f:t:0'）
  let uvMark = null;                       // 最近一次点选的元素

  const ctx = canvas.getContext('2d');

  function sizeCanvas(scale = 1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    // 实际位图尺寸已经取整，按它换算，确保重绘清到最后一行和一列像素。
    ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
    return { w, h };
  }

  function schedule() {
    if (raf || !active || !isVisible()) return;
    raf = requestAnimationFrame((ts) => {
      raf = 0;
      if (!active || !model || !isVisible()) {
        animStamp = 0;
        return;
      }
      if (playing && model.anim) {
        if (!animStamp) animStamp = ts;
        // 单帧最多推进 100ms：切走标签页再回来时不会一口气把整段动画跳完
        const dt = Math.min(0.1, Math.max(0, (ts - animStamp) / 1000));
        animStamp = ts;
        // 连续时基：曲线按 tick 线性插值，落在两帧之间也照常求值。
        // 早期那颗「逐帧播放」开关会把这里改成 1/fps 整帧量化，点下去看不出差别，已移除。
        animTime += dt;
        if (animTime > model.anim.duration) animTime = 0;
        applyModelAnimation(model, animTime);
        syncTimeline();
        // 播放期间固定走草稿档：Canvas 2D 软件光栅化每帧全量深度排序会掉帧
        draft = true;
      }
      // 草稿档只降分辨率，不抽样面：早期按 1/3 抽样，上万面的模型一拖动就少一半面，
      // 看着像模型缺块。这里始终按静止档的面数上限画，只是像素少一点，换拖动跟手。
      const heavy = model.triangles > RENDER_LIMITS.draft;
      const { w, h } = sizeCanvas((draft || view.spin) && heavy ? DRAFT_SCALE : 1);
      renderModel(ctx, model, view, w, h, RENDER_LIMITS.full);
      if (view.spin) view.yaw += 0.012;
      if ((view.spin || playing) && active) schedule();
    });
  }

  // 交互期间降分辨率重绘，手一停 180ms 再补一帧全分辨率的
  function scheduleDraft() {
    draft = true;
    schedule();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { draft = false; schedule(); }, 180);
  }

  function fullRepaint() {
    clearTimeout(idleTimer);
    draft = false;
    schedule();
  }

  function syncButtons() {
    for (const [key, b] of Object.entries(buttons)) {
      if (!b) continue;
      let on = false;
      if (key === 'solid') on = view.mode === 'solid';
      else if (key === 'wire') on = view.mode === 'wire';
      else if (key === 'both') on = view.mode === 'both';
      else if (key === 'spin') on = view.spin;
      else if (key === 'grid') on = !!view.grid;
      else if (key === 'flat') on = !view.sourceSmoothing;
      else if (key === 'smooth') on = !!view.sourceSmoothing;
      else if (key === 'vertices') on = !!view.vertexNumbers;
      else if (key === 'normals') on = !!view.vertexNormals;
      else if (key === 'origin') on = !!view.showOrigin;
      b.classList.toggle('on', on);
      if (key === 'spin' || key === 'grid' || key === 'vertices' || key === 'normals' || key === 'origin' || key === 'flat' || key === 'smooth') b.setAttribute('aria-pressed', String(on));
    }
  }

  function setMode(mode) {
    view.mode = mode;
    syncButtons();
    fullRepaint();
  }

  function reset() {
    const { yaw, pitch } = createView();
    Object.assign(view, { yaw, pitch, zoom: DEFAULT_ZOOM, panX: 0, panY: 0 });
    viewSelect.value = 'iso';
    fullRepaint();
  }

  viewSelect.addEventListener('change', () => {
    const angles = {
      iso: [0.62, 0.42], front: [0, 0], back: [Math.PI, 0],
      left: [Math.PI / 2, 0], right: [-Math.PI / 2, 0], top: [0, Math.PI / 2],
    };
    [view.yaw, view.pitch] = angles[viewSelect.value];
    fullRepaint();
  });

  function toggleSpin() {
    view.spin = !view.spin;
    syncButtons();
    if (view.spin) scheduleDraft();
    else fullRepaint();
  }

  function toggleWire() { setMode(view.mode === 'wire' ? 'solid' : 'wire'); }

  function toggleGrid() {
    view.grid = !view.grid;
    syncButtons();
    fullRepaint();
  }

  // ---- FBX 节点动画：独立工具条（帧 / 秒显示 + 连续播放）----
  function currentFrame() {
    const a = model && model.anim;
    if (!a) return 0;
    return Math.max(0, Math.min(a.frames, Math.round(animTime * a.fps)));
  }

  // 帧是工具条的基准：把秒换算成整数帧再求值，手动步进 / 拖时间轴都走这一条。
  // 曲线本身仍按 tick 求值，这里只决定「停在哪一帧」，不改动画数据。
  function setFrame(frame) {
    const a = model && model.anim;
    if (!a) return;
    const f = Math.max(0, Math.min(a.frames, Math.round(frame)));
    animTime = f / a.fps;
    applyModelAnimation(model, animTime);
    syncTimeline();
    fullRepaint();
  }

  function syncTimeline() {
    const a = model && model.anim;
    if (!a) return;
    const frame = currentFrame();
    if (animControls.timeline) animControls.timeline.value = String(frame);
    if (animControls.time) {
      animControls.time.textContent = animUnit === 'seconds'
        ? `${animTime.toFixed(2)} / ${a.duration.toFixed(2)} s`
        : `${frame} / ${a.frames} 帧`;
    }
    if (animControls.unit) {
      animControls.unit.textContent = animUnit === 'seconds' ? '秒' : '帧';
      animControls.unit.title = animUnit === 'seconds' ? '切换成帧显示' : '切换成秒显示';
    }
  }

  function setPlaying(on) {
    if (!model || !model.anim) return;
    playing = !!on;
    animStamp = 0;
    if (animControls.play) {
      animControls.play.textContent = playing ? '暂停' : '播放';
      animControls.play.setAttribute('aria-pressed', String(playing));
      animControls.play.classList.toggle('on', playing);
    }
    if (playing) schedule();
    else fullRepaint();
  }

  function stepFrame(dir) {
    if (!model || !model.anim) return;
    if (playing) setPlaying(false);   // 手动逐帧时先停，免得下一帧又被播放时基推走
    setFrame(currentFrame() + dir);
  }

  function toggleUnit() {
    if (!model || !model.anim) return;
    animUnit = animUnit === 'frames' ? 'seconds' : 'frames';
    syncTimeline();
  }

  const onAnimClick = (el, fn) => {
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  };
  onAnimClick(animControls.play, () => setPlaying(!playing));
  onAnimClick(animControls.first, () => { if (playing) setPlaying(false); setFrame(0); });
  onAnimClick(animControls.prev, () => stepFrame(-1));
  onAnimClick(animControls.next, () => stepFrame(1));
  onAnimClick(animControls.unit, toggleUnit);
  if (animControls.timeline) {
    animControls.timeline.addEventListener('input', (e) => {
      e.stopPropagation();
      if (playing) setPlaying(false);
      setFrame(Number(e.target.value));
    });
  }
  if (animControls.take) {
    animControls.take.addEventListener('change', (e) => {
      e.stopPropagation();
      if (!model || !model.anim) return;
      if (playing) setPlaying(false);
      if (!useAnimationTake(model, Number(e.target.value))) return;
      animTime = 0;
      if (animControls.timeline) {
        animControls.timeline.max = String(model.anim.frames);
        animControls.timeline.value = '0';
      }
      applyModelAnimation(model, 0);
      syncTimeline();
      fullRepaint();
    });
  }

  // 多 Take 时把下拉选项同步到工具条；单 Take / 无动画时整颗收起，不占位置
  function fillTakeOptions() {
    const sel = animControls.take;
    if (!sel) return;
    sel.textContent = '';
    const takes = model && model.anim ? model.anim.takes : null;
    if (!takes || takes.length <= 1) { sel.hidden = true; return; }
    for (let i = 0; i < takes.length; i++) {
      const name = takes[i].name || `Take ${i + 1}`;
      const dup = takes.filter((tk) => (tk.name || '') === (takes[i].name || '')).length > 1;
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = dup ? `${name} (${i + 1})` : name;
      sel.appendChild(opt);
    }
    sel.value = String(model.anim.take || 0);
    sel.hidden = false;
  }

  // ---- UV 通道 / 贴图 / 导出：只归 3D 工具条这一层管 ----
  const uvSet = () => (model && model.uvSets ? model.uvSets[uvSetIndex] : null);
  let uvCache = null;
  const uvData = () => {
    const s = uvSet();
    if (!s) return null;
    const key = JSON.stringify(uvState);
    if (!uvCache || uvCache.source !== s.uv || uvCache.key !== key)
      uvCache = { source:s.uv, key, data:transformUv(s.uv, uvState) };
    return uvCache.data;
  };

  function uvMsg(text, duration = 0) {
    clearTimeout(uvMessageTimer);
    if (!uvControls.msg) return;
    uvControls.msg.textContent = text || '';
    if (duration) uvMessageTimer = setTimeout(() => uvMsg(''), duration);
  }

  function fillUvSets() {
    const sel = uvControls.set;
    if (!sel) return;
    sel.textContent = '';
    const sets = model && model.uvSets ? model.uvSets : [];
    for (let i = 0; i < sets.length; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = sets[i].generated ? `UV${i}` : sets[i].name;
      o.title = sets[i].name;
      sel.appendChild(o);
    }
    uvSetIndex = Math.min(uvSetIndex, Math.max(0, sets.length - 1));
    sel.value = String(uvSetIndex);
    sel.disabled = sets.length <= 1;
  }

  // 「半透明」是一颗纯开关：按下就 100% 生效，没有中间档位。开着时贴图按亮度渐变
  // （add 语义）：黑 alpha=0、白 alpha=255、灰阶依次半透，不是整张统一变半透；
  // 关掉回到不透明原样。每次都从原图重画，不留上次的洞。
  function rebuildTexture() {
    texture = uvBitmap ? makeTexture(uvBitmap, {
      blackTransparent: false,
      additive: semiOn,
      threshold: 0,
      opacity: 1,
    }) : null;
  }

  // Layout and input stay in CSS pixels; only the backing bitmap uses device pixels.
  const uvCanvasSize = () => {
    const rect = uvControls.canvas.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  };
  function drawLayout() {
    const c = uvControls.canvas;
    const uv = uvData();
    if (!c || !uv || !uvPanelOn) return;
    const { width, height } = uvCanvasSize();
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(width * dpr)), ph = Math.max(1, Math.round(height * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const context = c.getContext('2d');
    context.setTransform(pw / width, 0, 0, ph / height, 0, 0);
    const r = drawUvLayout(context, uv, width, height, {
      seamFlags: uvSeamFlags(model.restPos || model.pos, uv),
      color: UV_COLORS.line, marks: uvMarks, element: uvElement,
      view: { zoom: uvZoom, center: uvCenter }, box: uvBox,
    });
    const s = uvSet();
    if (uvControls.panelName) uvControls.panelName.textContent = s ? s.name : '—';
    if (uvControls.panelInfo) {
      // 这里只报 UV 岛 / 元素选择 / 缩放信息（UV 变换已从界面移除，没有状态标签了）
      const label = { vertex: '点', edge: '线', face: '面', island: '元素' }[uvElement];
      const picked = uvElement === 'island'
        ? (uvMarks.size ? `已选 ${uvMarks.size} 面 · 整块 UV` : '点选或框选 UV 元素，整块 UV 一起高亮')
        : uvMarks.size > 1
          ? (uvElement === 'face' ? `已选 ${uvMarks.size} 面` : `已选 ${uvMarks.size} 个${label}`)
          : (uvMark ? (uvElement === 'face' ? `已选第 ${uvMark.tri} 面`
            : `已选 1 个${label}（第 ${uvMark.tri} 面）`) : `点选或框选 UV ${label}，模型上对应的元素会高亮`);
      const status = [
        s && s.generated ? '自动投影（源文件无 UV）' : '',
        `${r.total} 个面`,
        Math.abs(uvZoom - UV_DEFAULT_ZOOM) > 0.0001 ? `缩放 ${(uvZoom / UV_DEFAULT_ZOOM).toFixed(1)}×` : '',
        picked,
      ].filter(Boolean).join(' · ');
      uvControls.panelInfo.textContent = status;
      uvControls.panelInfo.title = status;
    }
  }

  // 左上角「模型信息」：比原来常驻的三行统计更细，位置仍是旧统计那一格。
  // 用 textContent + \n 而不是 innerHTML：解析器给的 label / 文件名不进 HTML。
  function paintInfo() {
    if (!uvControls.infoBody || !model) return;
    const m = model;
    const fmt = (n) => Number(n).toLocaleString('en-US');
    const nice = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    const box = m.bounds.size.map(nice).join(' × ');
    const min = m.bounds.min.map(nice).join(', ');
    const max = m.bounds.max.map(nice).join(', ');
    const sets = (m.uvSets || []).map((s) => s.name + (s.generated ? '（自动生成）' : '')).join(' / ') || '—';
    const a = m.anim;
    const sampled = m.triangles > RENDER_LIMITS.full
      ? `抽样  显示约 ${Math.ceil(m.triangles / Math.ceil(m.triangles / RENDER_LIMITS.full))} 面` : '';
    // 变换诊断：回答「变换是否已重置 / 缩放 XYZ 是不是都是 1 / 坐标是不是在 0 点」。
    // 带节点变换的格式（glTF / FBX / COLLADA / 3MF）按主网格节点静止姿态的物体级
    // 矩阵判定，见 model3d.js 的 model.transform / decomposeTransform()；纯顶点格式
    // 文件里没有物体变换这层信息，如实标注，另给顶点包围盒中心作偏移参考。
    const t = m.transform;
    const vec = (v) => v ? v.map(nice).join(', ') : '—';
    const yn = (b) => (b === null || b === undefined) ? '—' : (b ? '是' : '否');
    let tfLines;
    if (t && t.supported) {
      const why = [];
      if (!t.atOrigin) why.push('位置有偏移');
      if (!t.unitScale) why.push('缩放非 1');
      if (t.hasRotation) why.push('含节点旋转');
      if (t.mirrored || (t.scale || []).some((v) => v < 0)) why.push('含镜像 / 负缩放');
      if (t.degenerate) why.push('有零缩放');
      tfLines = [
        `变换已重置  ${yn(t.reset)}${t.reset ? '（位置 0 · 缩放 1 · 无旋转）' : (why.length ? ' · ' + why.join(' / ') : '')}`,
        `坐标在 0 点  ${yn(t.atOrigin)} · (${vec(t.translation)})`,
        `缩放 XYZ=1  ${yn(t.unitScale)} · (${vec(t.scale)})`,
      ];
    } else {
      tfLines = [
        '变换已重置  —（该格式不含物体变换信息）',
        `坐标在 0 点  —（变换已烘焙进顶点）· 顶点中心 (${vec(t && t.geomCenter)})`,
        '缩放 XYZ=1  —（无法判定）',
      ];
    }
    const lines = [
      `文件  ${modelName || '—'}`,
      `格式  ${String(m.format || '').toUpperCase()} · ${m.label || '—'}`,
      `三角面  ${fmt(m.triangles)}`,
      `顶点  ${fmt(m.vertices)}`,
      `骨骼数量  ${fmt(m.boneCount || 0)}`,
      `材质  ${fmt(m.materials || 0)}`,
      `UV 通道  ${(m.uvSets || []).length} 套 · ${sets}`,
      `贴图  ${texture ? `${textureName || '已指定'} · ${texture.w}×${texture.h}` : '未指定'}`,
      `包围盒  ${box}`,
      `坐标范围  ${min} → ${max}`,
      ...tfLines,
      `动画  ${a ? `${a.frames} 帧 · ${Number(a.duration).toFixed(2)} s · ${a.fps} fps · ${(a.takes || []).length} Take` : '无'}`,
      `法线 / 顶点色  ${m.nrm && m.nrm.length ? '有' : '无'} / ${m.col && m.col.length ? '有' : '无'}`,
      ...(sampled ? [sampled] : []),
      ...(m.warnings || []).map((w) => `提示  ${w}`),
    ];
    uvControls.infoBody.textContent = lines.join('\n');
  }

  // 所有 UV 操作都汇到这一处：变换后的 UV、半透明贴图、线框开关、选中元素一起挂到 view 上，
  // 再重画 3D 帧和 UV 展开图。导出读的也是 uvData()，所以「所见即所存」。
  function syncUv({ repaint = true } = {}) {
    if (!model) return;
    const s = uvSet();
    if (uvControls.set) uvControls.set.title = s?.name || '';
    view.uv = uvData();
    view.texture = texture;
    view.uvWire = uvWireOn;
    view.uvSeams = uvWireOn && uvPanelOn && view.uv ? uvSeamFlags(model.restPos || model.pos, view.uv) : null;
    view.uvPick = uvPick;
    view.uvPicks = uvPicks;
    view.uvMarks = uvMarks;
    view.projection = projection;
    if (uvControls.wire) uvControls.wire.classList.toggle('on', uvWireOn);
    if (uvControls.view) uvControls.view.classList.toggle('on', uvPanelOn);
    // 半透明是一颗纯开关：没指定贴图时禁用，按下就 100% 亮度渐变，没有滑条。
    if (uvControls.alpha) {
      uvControls.alpha.classList.toggle('on', semiOn);
      uvControls.alpha.disabled = !uvBitmap;
      uvControls.alpha.setAttribute('aria-pressed', String(semiOn));
    }
    // 点 / 线 / 面 / 元素 四档分段控件，当前档按下态
    for (const [kind, el] of Object.entries({ vertex: uvControls.elemV, edge: uvControls.elemE,
      face: uvControls.elemF, island: uvControls.elemI })) {
      if (!el) continue;
      el.classList.toggle('on', uvElement === kind);
      el.setAttribute('aria-pressed', String(uvElement === kind));
    }
    const ortho = projection === 'orthographic';
    if (uvControls.proj) {
      uvControls.proj.classList.toggle('on', ortho);
      uvControls.proj.setAttribute('aria-pressed', String(ortho));
      uvControls.proj.textContent = ortho ? '正交视图' : '透视视图';
    }
    paintInfo();
    if (uvControls.clearTex) uvControls.clearTex.disabled = !uvBitmap;
    if (uvControls.panelName && s) uvControls.panelName.textContent = s.name;
    if (uvPanelOn) {
      fitUvPanel();
      drawLayout();
    }
    if (repaint) fullRepaint();
  }

  function toggleUvPanel(force) {
    uvPanelOn = force === undefined ? !uvPanelOn : !!force;
    // 关闭 UV 窗口时一并清掉 3D 视图里高亮的 UV 选择，模型上不再残留青色高亮
    if (!uvPanelOn) {
      uvMarks = new Set();
      uvPicks = new Set();
      uvPick = -1;
      uvMark = null;
    }
    if (uvPanel) uvPanel.hidden = !uvPanelOn;
    syncUv();
  }

  function toggleProjection(force) {
    projection = force === undefined
      ? (projection === 'orthographic' ? 'perspective' : 'orthographic') : force;
    view.projection = projection;
    syncUv();
  }

  function setElement(kind) {
    if (!['vertex', 'edge', 'face', 'island'].includes(kind)) return;
    uvElement = kind;
    uvMarks = new Set();
    uvMark = null;
    uvPick = -1;
    uvPicks = new Set();
    syncUv();
  }

  function semiMsg() {
    if (!semiOn) return '半透明已关 · 贴图恢复不透明';
    return `半透明已开 · 100% · ${textureName || '贴图'} · 亮度渐变：黑透白不透`
      + `${texture ? ` · 透掉 ${texture.transparent} 像素` : ''}`;
  }

  // 导入贴图 / 拖入图片的共同落点：换掉这一张图，其余 UV 状态全留着。
  function applyTexture({ bitmap, name }) {
    if (!bitmap) return;
    if (uvBitmap && uvBitmap !== bitmap && uvBitmap.close) uvBitmap.close();
    uvBitmap = bitmap;
    textureName = name || '';
    rebuildTexture();
    syncUv();
    uvMsg(`已导入 ${textureName}${texture ? ` · ${texture.w}×${texture.h}` : ''}${semiOn && texture ? ` · 透掉 ${texture.transparent} 像素` : ''}`, 3000);
  }

  async function importTexture() {
    if (!onImportTexture) return;
    const target = model;
    try {
      const result = await onImportTexture();
      if (!result) return;
      if (target !== model) {
        result.bitmap.close();
        return;
      }
      applyTexture(result);
    } catch (err) {
      uvMsg(`贴图导入失败：${(err && err.message) || err}`);
    }
  }

  // 清除贴图只动「这一张图」：UV 通道、半透明开关、选面全留着，贴图文件引用一并清掉。
  function clearTexture() {
    if (!uvBitmap) return;
    if (uvBitmap.close) uvBitmap.close();
    uvBitmap = null;
    texture = null;
    textureName = '';
    syncUv();
    uvMsg('已清除贴图', 3000);
  }

  // FBX 另存入口已随顶部工具条的「导出 FBX」按钮一起移除：运行时不再生成 FBX 文本、
  // 不再写盘。工具层 model-uv.js 的 exportFbxAscii() 仍在，由独立台架覆盖，但界面没有调用它的入口。

  const onUvClick = (el, fn) => {
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  };
  onUvClick(uvControls.wire, () => { uvWireOn = !uvWireOn; syncUv(); });
  onUvClick(uvControls.view, () => toggleUvPanel());
  onUvClick(uvControls.panelX, () => toggleUvPanel(false));
  onUvClick(uvControls.proj, () => toggleProjection());
  onUvClick(uvControls.alpha, () => {
    if (!uvBitmap) return;             // 没贴图时不响应（按钮本身也是 disabled）
    semiOn = !semiOn;
    rebuildTexture();
    syncUv();
    uvMsg(semiMsg());
  });
  onUvClick(uvControls.elemV, () => setElement('vertex'));
  onUvClick(uvControls.elemE, () => setElement('edge'));
  onUvClick(uvControls.elemF, () => setElement('face'));
  onUvClick(uvControls.elemI, () => setElement('island'));
  // UV 变换（旋转 / 镜像 / 还原）不再有 UI 入口：uvState 恒为 DEFAULT_UV_STATE，
  // 但 uvData() / transformUv() 仍吃同一份；工具层 exportFbxAscii() 也保留，只是界面无入口。
  onUvClick(uvControls.tex, importTexture);
  onUvClick(uvControls.clearTex, clearTexture);
  onUvClick(uvControls.exportUv, () => {
    const uv=uvData();
    if (!uv) { uvMsg('当前模型没有 UV'); return; }
    if (onExportUv) onExportUv({
      channels: model.uvSets.map((set, i) => ({ name: set.name, uv: i === uvSetIndex ? uv.slice() : transformUv(set.uv, uvState) })),
      selectedChannel: uvSetIndex, positions: (model.restPos || model.pos).slice(), name: modelName || 'model',
    });
    else uvMsg('预览模式未接入导出');
  });
  if (uvControls.set) {
    uvControls.set.addEventListener('change', (e) => {
      e.stopPropagation();
      uvSetIndex = Number(e.target.value) || 0;
      uvPick = -1;
      uvPicks = new Set();
      uvMarks = new Set();
      uvMark = null;
      syncUv();
    });
  }

  // ---- UV 画布：右键 / 中键拖平移 / 左键拖框选 / 单击点选 / 滚轮缩放 / 双击回 1:1 ----
  // 绘制与鼠标操作统一用 CSS 像素，DPI 只影响画布底层位图，
  // 再经 uvLayoutView 反算成 UV 空间，缩放 / 平移后框选和单选都不会偏。
  if (uvControls.canvas) {
    const c = uvControls.canvas;
    const toCanvas = (e) => {
      const r = c.getBoundingClientRect();
      return {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      };
    };
    const toUv = (p) => {
      const m = uvLayoutView(uvCanvasSize().width, uvCanvasSize().height, { zoom: uvZoom, center: uvCenter });
      return { u: m.u(p.x), v: m.v(p.y) };
    };
    // 右键 / 中键这一趟是平移画布、左键是框选：c0 记住按下那一刻的中心，
    // 平移按总位移算而不是逐帧累加，拖多远都不会漂。
    const startUvDrag = (e, isPan) => {
      const p = toCanvas(e);
      uvSelDrag = { mode: isPan ? 'pan' : 'select', x0: p.x, y0: p.y,
        x1: p.x, y1: p.y, moved: false, c0: { ...uvCenter } };
      c.classList.toggle('uv-panning', isPan);
      c.classList.toggle('uv-selecting', !isPan);
    };
    // button 1 是中键：按住拖和右键走完全同一条平移通路，不参与选面。
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      e.stopPropagation();
      e.preventDefault();
      startUvDrag(e, e.button !== 0);
    });
    // 中键落在画布以外的 UV 窗口空白处（页脚 / 工具区）也算平移，手势和画布内右键一致；
    // 按钮、下拉、缩放手柄这些控件让给它们自己。preventDefault 顺带掐掉 Chromium
    // 中键按下时那套自动滚动，auxclick 再兜一层默认行为。
    if (uvPanel) {
      uvPanel.addEventListener('mousedown', (e) => {
        if (e.button !== 1 || e.target === c ||
            e.target.closest?.('button, select, input, .uvpanel-grip')) return;
        e.stopPropagation();
        e.preventDefault();
        startUvDrag(e, true);
      });
      uvPanel.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        e.stopPropagation();
        e.preventDefault();
      });
    }
    // 右键用来平移，别让它弹出浏览器原生右键菜单（面板已拦住冒泡，这里再吃掉默认）
    c.addEventListener('contextmenu', (e) => { e.stopPropagation(); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!uvSelDrag) return;
      const p = toCanvas(e);
      uvSelDrag.x1 = p.x;
      uvSelDrag.y1 = p.y;
      // 框选最小拖拽阈值：原来 3px，降到 2.7px（小 10%），小范围拖动也稳定触发框选而非被当成单击。
      if (Math.hypot(p.x - uvSelDrag.x0, p.y - uvSelDrag.y0) > 3 * 0.9) uvSelDrag.moved = true;
      if (!uvSelDrag.moved) return;
      if (uvSelDrag.mode === 'pan') {
        const m = uvLayoutView(uvCanvasSize().width, uvCanvasSize().height, { zoom: uvZoom, center: uvSelDrag.c0 });
        // 鼠标往右拖，UV 图也跟着往右走，所以中心要减去这段 UV 位移。
        uvCenter = {
          u: uvSelDrag.c0.u - (p.x - uvSelDrag.x0) / (m.W * m.zoom),
          v: uvSelDrag.c0.v - (p.y - uvSelDrag.y0) / (m.H * m.zoom),
        };
        uvBox = null;
      } else {
        uvBox = { x0: uvSelDrag.x0, y0: uvSelDrag.y0, x1: p.x, y1: p.y };
      }
      drawLayout();
    });
    // uvPanel 为了挡住主窗口的拖窗口 / 右键菜单，会在冒泡阶段拦掉 mouseup；
    // 这里走捕获阶段，保证拖拽到画布外松手也收得到。
    window.addEventListener('mouseup', (e) => {
      if (!uvSelDrag || (e.button !== 0 && e.button !== 1 && e.button !== 2)) return;
      const d = uvSelDrag;
      uvSelDrag = null;
      c.classList.remove('uv-panning', 'uv-selecting');
      // 右键 / 中键这一趟是平移（或只是单击没动）：都不该选面，也不清已有的选择；
      // 左键单击（没移动）才照常点选元素。
      if (d.mode === 'pan') { drawLayout(); return; }
      uvBox = null;
      const uv = uvData();
      const layout = uvLayoutView(uvCanvasSize().width, uvCanvasSize().height, { zoom: uvZoom, center: uvCenter });
      const tol = 8 / Math.max(1, layout.W * layout.zoom);   // 画布 8px 的命中半径，缩放后手感一致
      if (uv) {
        let picked = [];
        // 框选给矩形加一点边距容差（按点击容差 tol 折算到 UV 空间），贴着框边的 UV
        // 元素也能选进来——相当于把框选生效的最小范围缩到更小，小框也好框选。
        const cap = (d.moved ? tol : 0);
        const boxRect = (a, b) => ({
          u0: Math.min(a.u, b.u) - cap, v0: Math.min(a.v, b.v) - cap,
          u1: Math.max(a.u, b.u) + cap, v1: Math.max(a.v, b.v) + cap,
        });
        if (uvElement === 'island') {
          // 「元素」档：点中 / 框到的每个面都扩成整块连通 UV 岛，合并成一组面标记。
          // 面标记在 UV 窗口里会整片半透明填充，模型上也由 uvPicks 一起高亮。
          let seeds = [];
          if (d.moved) {
            const a = toUv({ x: d.x0, y: d.y0 }), b = toUv({ x: d.x1, y: d.y1 });
            seeds = pickUvTrianglesInRect(uv, boxRect(a, b));
          } else {
            const p = toUv({ x: d.x0, y: d.y0 });
            const t = pickUvTriangle(uv, p.u, p.v);
            if (t >= 0) seeds = [t];
          }
          const tris = uvIslandTriangles(uv, seeds);
          picked = [...tris].map((tri) => ({ kind: 'face', tri, idx: 0 }));
        } else if (d.moved) {
          const a = toUv({ x: d.x0, y: d.y0 }), b = toUv({ x: d.x1, y: d.y1 });
          const rect = boxRect(a, b);
          picked = uvElement === 'face'
            ? pickUvTrianglesInRect(uv, rect).map((tri) => ({ kind: 'face', tri, idx: 0 }))
            : pickUvElementsInRect(uv, rect, { element: uvElement });
        } else {
          const p = toUv({ x: d.x0, y: d.y0 });
          if (uvElement === 'face') {
            const t = pickUvTriangle(uv, p.u, p.v);
            if (t >= 0) picked = [{ kind: 'face', tri: t, idx: 0 }];
          } else {
            const hit = pickUvElement(uv, p.u, p.v, { element: uvElement, tol });
            if (hit) picked = [hit];
          }
        }
        const pickedKeys = picked.map((m) => uvMarkKey(m.kind, m.tri, m.idx));
        // 加选 / 减选：Ctrl（或 ⌘）把本次结果并进去，Alt 把本次结果剔出来；都不按则替换。
        // 只有面和元素选择会填充模型表面；点和线由独立的标记层绘制。
        if (e.ctrlKey || e.metaKey) uvMarks = new Set([...uvMarks, ...pickedKeys]);
        else if (e.altKey) {
          const drop = new Set(pickedKeys);
          uvMarks = new Set([...uvMarks].filter((k) => !drop.has(k)));
        } else uvMarks = new Set(pickedKeys);
        uvPick = -1;
        uvPicks = new Set();
        for (const key of uvMarks) {
          const m = parseUvMark(key);
          if (!m) continue;
          if (m.kind === 'face') { uvPicks.add(m.tri); if (uvPick < 0) uvPick = m.tri; }
        }
        // 信息锚到「还在选择里」的最后一个点到的元素；减选把刚点到的元素剔掉后，
        // 锚点要回落到剩余选择里的某个元素，不能还指着已被剔除的那个（否则页脚会写
        // 「已选第 0 面」而实际高亮的是另一块）。选空了就置空。
        const lastKey = picked.length
          ? uvMarkKey(picked[picked.length - 1].kind, picked[picked.length - 1].tri, picked[picked.length - 1].idx)
          : null;
        uvMark = (uvMarks.size && lastKey && uvMarks.has(lastKey))
          ? picked[picked.length - 1]
          : (uvMarks.size ? parseUvMark([...uvMarks][0]) : null);
      }
      syncUv();
    }, true);
    // 蓝色 UV 边框的中心是 UV (0.5, 0.5)。平移后它可能偏离画布中心。
    const wheelTarget = uvControls.panel || c;
    wheelTarget.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.deltaY === 0) return;
      const nextZoom = Math.max(UV_MIN_ZOOM, Math.min(12, uvZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (nextZoom === uvZoom) return;
      const ratio = uvZoom / nextZoom;
      uvCenter = {
        u: 0.5 + (uvCenter.u - 0.5) * ratio,
        v: 0.5 + (uvCenter.v - 0.5) * ratio,
      };
      uvZoom = nextZoom;
      drawLayout();
    }, { passive: false });
    // 双击画布：缩放倍率和「平移 + 缩放中心」一起回默认留白视图，拖飞了也能一下找回来
    c.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      uvZoom = UV_DEFAULT_ZOOM;
      uvCenter = { u: 0.5, v: 0.5 };
      drawLayout();
    });
  }

  if (uvControls.canvas) {
    new ResizeObserver(() => drawLayout()).observe(uvControls.canvas);
    // Moving between monitors can change DPR without changing the CSS canvas size.
    const watchUvDpi = () => {
      const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', () => { drawLayout(); watchUvDpi(); }, { once: true });
    };
    watchUvDpi();
    const uvBoundsObserver = new ResizeObserver(() => {
      fitUvPanel(uvGripDrag?.requestedSize);
    });
    uvBoundsObserver.observe(stage);
    uvBoundsObserver.observe(viewportTools);
  }

  function fitUvPanel(size) {
    const panel = uvPanel, c = uvControls.canvas;
    if (!uvPanelOn || !panel || !c || panel.hidden) return;
    if (!stage.clientWidth || !stage.clientHeight) return;
    const frameWidth = panel.offsetWidth - c.offsetWidth;
    const frameHeight = panel.offsetHeight - c.offsetHeight;
    const available = Math.min(
      stage.clientWidth - 16 - frameWidth,
      stage.clientHeight - viewportTools.offsetHeight - 30 - frameHeight,
    );
    const preferred = Math.max(UV_CANVAS_MIN, size ?? uvPreferredSize ?? UV_CANVAS_DEFAULT);
    const next = Math.max(1, Math.floor(Math.min(UV_CANVAS_MAX, available, preferred)));
    const panelWidth = `${next + frameWidth}px`;
    if (panel.style.width !== panelWidth) panel.style.width = panelWidth;
    return next;
  }

  // 面板右上角固定，左下角沿位移较大的方向等比缩放画布。
  if (uvControls.grip && uvControls.panel && uvControls.canvas) {
    const grip = uvControls.grip;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      e.stopPropagation();
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      uvGripDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, size: uvCanvasSize().width };
    });
    grip.addEventListener('pointermove', (e) => {
      if (uvGripDrag?.id !== e.pointerId) return;
      const dx = uvGripDrag.x - e.clientX;
      const dy = e.clientY - uvGripDrag.y;
      uvGripDrag.requestedSize = uvGripDrag.size + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
      fitUvPanel(uvGripDrag.requestedSize);
    });
    grip.addEventListener('pointerup', (e) => {
      if (uvGripDrag?.id !== e.pointerId) return;
      const { requestedSize } = uvGripDrag;
      uvGripDrag = null;
      if (requestedSize !== undefined) {
        rememberUvSize(Math.min(UV_CANVAS_MAX, Math.max(UV_CANVAS_MIN, requestedSize)));
      }
    });
    grip.addEventListener('lostpointercapture', (e) => {
      if (uvGripDrag?.id !== e.pointerId) return;
      uvGripDrag = null;
      fitUvPanel();
    });
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      rememberUvSize(UV_CANVAS_DEFAULT);
      fitUvPanel();
    });
  }

  // ---- 输入路由：一律挡在 stage 之前 ----
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };

  canvas.addEventListener('mousedown', (e) => {
    // button 1 是中键：和右键走同一条平移通路（panX / panY），不旋转、不弹菜单。
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    stop(e);   // 顺带掐掉 Chromium 中键按下时那套自动滚动
    canvas.focus({ preventScroll: true });
    drag = { btn: e.button, x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch,
      panX: view.panX, panY: view.panY };
    canvas.classList.add('dragging');
  });
  // 中键松手还会派发 auxclick，浏览器默认拿它开自动滚动 / 剪贴板粘贴，一并吃掉
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) stop(e); });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !active) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    // 右键 / 中键都是平移模型；只有左键才转视角
    if (drag.btn === 2 || drag.btn === 1) {
      view.panX = drag.panX + dx;
      view.panY = drag.panY + dy;
    } else {
      view.yaw = drag.yaw + dx * 0.009;
      // 鼠标上下移动时，模型上下翻转方向取反：往下拖模型也跟着往下翻，符合直觉
      view.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch + dy * 0.009));
    }
    scheduleDraft();
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag || e.button !== drag.btn) return;
    drag = null;
    canvas.classList.remove('dragging');
    fullRepaint();
  });
  window.addEventListener('blur', () => {
    drag = null;
    canvas.classList.remove('dragging');
    // 中键 / 右键在窗口外松手时收不到 mouseup，失焦时一并收掉平移状态
    if (uvSelDrag) {
      uvSelDrag = null;
      if (uvControls.canvas) uvControls.canvas.classList.remove('uv-panning', 'uv-selecting');
    }
  });
  canvas.addEventListener('wheel', (e) => {
    stop(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 400;
    if (!dy) return;
    view.zoom = Math.max(0.18, Math.min(9, view.zoom * Math.exp(-dy * 0.0014)));
    scheduleDraft();
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => { stop(e); reset(); });
  canvas.addEventListener('contextmenu', stop);
  // 两条控制条上的操作都不能落到「拖窗口 / 弹右键菜单」那两路上
  for (const ev of ['mousedown', 'mouseup', 'dblclick', 'contextmenu', 'wheel']) {
    for (const b of [bar, animBar, uvBar, uvPanel]) {
      if (b) b.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
  }

  for (const [key, b] of Object.entries(buttons)) {
    if (!b) continue;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (key === 'reset') reset();
      else if (key === 'spin') toggleSpin();
      else if (key === 'grid') toggleGrid();
      else if (key === 'flat' || key === 'smooth') {
        view.sourceSmoothing = key === 'smooth'; syncButtons(); fullRepaint();
        if (view.sourceSmoothing && !model?.hasSourceNormals) uvMsg('当前模型没有可用的源光滑组或顶点法线，保持平面着色');
      }
      else if (key === 'vertices' || key === 'normals') {
        const flag = key === 'vertices' ? 'vertexNumbers' : 'vertexNormals';
        view[flag] = !view[flag];
        syncButtons();
        fullRepaint();
      }
      else if (key === 'origin') {
        view.showOrigin = !view.showOrigin;
        syncButtons();
        fullRepaint();
      }
      else setMode(key);
    });
  }

  window.addEventListener('resize', () => { if (active) fullRepaint(); });

  async function load({ bytes, ext, name, resolveUri }) {
    const m = await parseModel(bytes, ext, { resolveUri });
    model = m;
    modelName = name || '';
    view = createView();
    viewSelect.value = 'iso';
    view.zoom = DEFAULT_ZOOM;
    view.projection = projection;
    active = true;
    // 切换模型时清除与旧模型绑定的 UV 选择和贴图。
    uvState = { ...DEFAULT_UV_STATE };
    uvSetIndex = 0;
    uvWireOn = false;
    uvPanelOn = false;
    uvPick = -1;
    uvPicks = new Set();
    uvMarks = new Set();
    uvMark = null;
    uvZoom = UV_DEFAULT_ZOOM;
    uvCenter = { u: 0.5, v: 0.5 };
    uvBox = null;
    uvSelDrag = null;
    uvGripDrag = null;
    semiOn = false;
    if (uvBitmap && uvBitmap.close) uvBitmap.close();
    uvBitmap = null;
    texture = null;
    textureName = '';
    fillUvSets();
    uvMsg('');
    // 静态模型收起动画工具条。
    playing = false;
    animTime = 0;
    animStamp = 0;
    animUnit = 'frames';   // 每打开一个新文件都回到默认的「帧」显示
    const hasAnim = !!m.anim;
    if (animBar) animBar.hidden = !hasAnim;
    fillTakeOptions();
    // 每打开一个文件都按「有没有动画」重算底部提示，翻图时不会留着上一张的播放说明
    if (animControls.play) {
      animControls.play.textContent = '播放';
      animControls.play.setAttribute('aria-pressed', 'false');
      animControls.play.classList.remove('on');
    }
    if (animControls.timeline) {
      animControls.timeline.max = String(hasAnim ? m.anim.frames : 1);
      animControls.timeline.value = '0';
    }
    if (hasAnim) {
      resetModelPose(m);
      syncTimeline();
    }
    canvas.hidden = false;
    bar.hidden = false;
    if (uvBar) uvBar.hidden = false;
    if (uvPanel) uvPanel.hidden = true;
    info.hidden = false;
    syncButtons();
    syncUv({ repaint: false });
    fullRepaint();
    return m;
  }

  function dispose() {
    if (!active && !model) return;
    active = false;
    playing = false;
    animStamp = 0;
    if (animBar) animBar.hidden = true;
    if (animControls.take) { animControls.take.hidden = true; animControls.take.textContent = ''; }
    model = null;
    uvCache = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(idleTimer);
    drag = null;
    canvas.classList.remove('dragging');
    canvas.hidden = true;
    bar.hidden = true;
    if (uvBar) uvBar.hidden = true;
    if (uvPanel) uvPanel.hidden = true;
    uvPanelOn = false;
    uvWireOn = false;
    uvPick = -1;
    uvPicks = new Set();
    uvMarks = new Set();
    uvMark = null;
    semiOn = false;
    uvZoom = UV_DEFAULT_ZOOM;
    uvCenter = { u: 0.5, v: 0.5 };
    uvBox = null;
    uvSelDrag = null;
    uvGripDrag = null;
    if (uvBitmap && uvBitmap.close) uvBitmap.close();
    uvBitmap = null;
    texture = null;
    textureName = '';
    uvMsg('');
    view.uv = null;
    view.texture = null;
    view.uvWire = false;
    view.uvPick = -1;
    view.uvPicks = null;
    view.uvMarks = null;
    if (info) info.setAttribute('hidden', '');
    canvas.width = canvas.height = 1;
    const uvCanvas = uvControls.canvas;
    if (uvCanvas) uvCanvas.width = uvCanvas.height = 1;
  }

  return {
    load, dispose, reset, applyTexture,
    redraw() {
      fullRepaint();
      if (isVisible()) fitUvPanel();
    },
    capture() {
      const { w, h } = sizeCanvas();
      renderModel(ctx, model, view, w, h, RENDER_LIMITS.full);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    },
    key(e) {
      if (!active || !isVisible() || e.ctrlKey || e.altKey || e.metaKey) return false;
      const k = e.key.toLowerCase();
      // U 显示 UV 线框、V 开 UV 视图：3D 专用，和图片模式里 U（去黑）不是一回事
      if (k === 'escape' && uvPanelOn) { e.preventDefault(); toggleUvPanel(false); return true; }
      if (k === 'u' || k === 'v') { e.preventDefault(); toggleUvPanel(); return true; }
      if (k === '1') { e.preventDefault(); setMode('solid'); return true; }
      if (k === '2') { e.preventDefault(); setMode('wire'); return true; }
      if (k === '3') { e.preventDefault(); setMode('both'); return true; }
      if (k === 'w') { e.preventDefault(); toggleWire(); return true; }
      if (k === 'g') { e.preventDefault(); toggleGrid(); return true; }
      if (k === 'f' || k === 'r') { e.preventDefault(); reset(); return true; }
      if ((e.key === ' ' || e.code === 'Space') && model && model.anim) {
        e.preventDefault();
        setPlaying(!playing);
        return true;
      }
      // , / . 是逐帧后退 / 前进（←/→ 已经留给翻图，不能占用）
      if ((e.key === ',' || e.key === '<') && model && model.anim) { e.preventDefault(); stepFrame(-1); return true; }
      if ((e.key === '.' || e.key === '>') && model && model.anim) { e.preventDefault(); stepFrame(1); return true; }
      return false;
    },
  };
}
