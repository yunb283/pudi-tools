import { CanvasView } from './view.js';
import { makeZoomPan } from './zoom-pan.js';
import { initSplit } from './split.js';
import { initMerge } from './merge.js';
import { initConvert } from './convert.js';
import { initNormal } from './normal-page.js';
import { initSeamless } from './seamless-page.js';
import { initGif } from './gif-page.js';
import { initGifView } from './gif-view-page.js';
import { initVideoConvert } from './video-convert-page.js';
import { initAudioConvert } from './audio-convert-page.js';
import { initVideoDownload } from './video-download-page.js';
import { initPdfPage } from './pdf-page.js';
import { initSysInfo } from './sysinfo-page.js';
import { initShutdown } from './shutdown-page.js';
import { initFlipClock } from './clock-page.js';
import { initFlowmap } from './flowmap-page.js';
import { initModelPage } from './model-page.js';
import { initRenamePage } from './rename-page.js';
import { initSftexPage } from './sftex-page.js';
import {
  onGlobalDrop,
  isSupportedName,
  isModelName,
  isTauri,
  TEXTURE_EXTS,
  GIF_SOURCE_EXTS,
  GIF_ONLY_EXTS,
  VIDEO_EXTS,
} from './platform.js';
import { ripple, placePill, popOnce, prefersReduced } from './ui-motion.js';

function makeBgButtons(container, view, modes, current) {
  const names = ['黑', '亮', '棋盘格', '暗'];
  container.innerHTML = '';
  const btns = {};
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'bg-btn' + (m === current ? ' checked' : '');
    b.title = names[m];
    const s = document.createElement('span');
    s.className = 'bg-swatch ' + ['black', 'light', 'checker', 'dark'][m];
    b.appendChild(s);
    b.addEventListener('click', () => {
      view.bgMode = m;
      for (const x of Object.values(btns)) x.classList.remove('checked');
      b.classList.add('checked');
      view.redraw();
    });
    btns[m] = b;
    container.appendChild(b);
  }
}

// 预览窗是 <img>/CSS 底色，不是 CanvasView，这里只切 class
function makeCssBgButtons(container, el, modes, current) {
  const names = ['黑', '亮', '棋盘格', '暗'];
  const cls = ['bg-black', 'bg-light', 'bg-checker', 'bg-dark'];
  const apply = (m) => {
    el.classList.remove(...cls);
    el.classList.add(cls[m]);
  };
  container.innerHTML = '';
  apply(current);
  const btns = {};
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'bg-btn' + (m === current ? ' checked' : '');
    b.title = names[m];
    const s = document.createElement('span');
    s.className = 'bg-swatch ' + ['black', 'light', 'checker', 'dark'][m];
    b.appendChild(s);
    b.addEventListener('click', () => {
      apply(m);
      for (const x of Object.values(btns)) x.classList.remove('checked');
      b.classList.add('checked');
    });
    btns[m] = b;
    container.appendChild(b);
  }
}

// 右侧预览的视图工具，插在它那排背景色块的左边
function makeViewTools(bgContainer, api) {
  const box = document.createElement('div');
  box.className = 'view-tools';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'view-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  mk('重置位置', '平移归零，保留当前缩放', () => api.resetPan());
  mk('100%', '一个图像像素对一个屏幕像素', () => api.zoomActual());
  mk('适配窗口', '整张图铺满窗口并归位', () => api.fitWindow());
  bgContainer.parentNode.insertBefore(box, bgContainer);
}

const tabSplit = document.getElementById('tab-split');
const tabMerge = document.getElementById('tab-merge');
const tabConvert = document.getElementById('tab-convert');
const tabNormal = document.getElementById('tab-normal');
const tabSeamless = document.getElementById('tab-seamless');
const tabSftex = document.getElementById('tab-sftex');
const tabFlowmap = document.getElementById('tab-flowmap');
const tabModel = document.getElementById('tab-model');
const tabGif = document.getElementById('tab-gif');
const tabGifView = document.getElementById('tab-gifview');
const tabVideo = document.getElementById('tab-video');
const tabAudio = document.getElementById('tab-audio');
const tabDl = document.getElementById('tab-dl');
const tabClock = document.getElementById('tab-clock');
const tabRename = document.getElementById('tab-rename');
const tabSysInfo = document.getElementById('tab-sysinfo');
const tabDiskmon = document.getElementById('tab-diskmon');
const tabShutdown = document.getElementById('tab-shutdown');
const pageSplit = document.getElementById('page-split');
const pageMerge = document.getElementById('page-merge');
const pageConvert = document.getElementById('page-convert');
const pageNormal = document.getElementById('page-normal');
const pageSeamless = document.getElementById('page-seamless');
const pageSftex = document.getElementById('page-sftex');
const pageFlowmap = document.getElementById('page-flowmap');
const pageModel = document.getElementById('page-model');
const pageGif = document.getElementById('page-gif');
const pageGifView = document.getElementById('page-gifview');
const pageVideo = document.getElementById('page-video');
const pageAudio = document.getElementById('page-audio');
const pageDl = document.getElementById('page-dl');
const tabPdf = document.getElementById('tab-pdf');
const pagePdf = document.getElementById('page-pdf');
const tabWord = document.getElementById('tab-word');
const pageWord = document.getElementById('page-word');
const pageClock = document.getElementById('page-clock');
const pageRename = document.getElementById('page-rename');
const pageSysInfo = document.getElementById('page-sysinfo');
const pageDiskmon = document.getElementById('page-diskmon');
const pageShutdown = document.getElementById('page-shutdown');

// 科幻纹理生成：iframe 懒加载 + 缩放 + 保存桥接都收在这个模块里
const sftexApi = initSftexPage();

const srcView = new CanvasView(document.getElementById('src-canvas'), {
  clickable: true,
  bgMode: 3,
});
const frameView = new CanvasView(document.getElementById('frame-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const mergeView = new CanvasView(document.getElementById('merge-canvas'), {
  bgMode: 2,
  gridColor: 'rgba(77,217,255,0.9)',
  hlColor: '#FFD926',
  zoomable: true,
});
const convView = new CanvasView(document.getElementById('conv-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const nrmSrcView = new CanvasView(document.getElementById('nrm-src-canvas'), { bgMode: 2 });
const nrmOutView = new CanvasView(document.getElementById('nrm-out-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const smlSrcView = new CanvasView(document.getElementById('sml-src-canvas'), {
  bgMode: 2,
  selectable: true,
  zoomable: true,
});
const smlOutView = new CanvasView(document.getElementById('sml-out-canvas'), {
  bgMode: 2,
  zoomable: true,
});
const gifSrcView = new CanvasView(document.getElementById('gif-src-canvas'), {
  bgMode: 2,
  selectable: true,
});
// GIF 动画预览：整幅画面就这一张 canvas，播放/暂停/拖动都在这里。
// selectable 只是注册框选，默认关着（页面里 setSelectEnabled），进裁剪模式才接管左键
const gvView = new CanvasView(document.getElementById('gv-canvas'), {
  bgMode: 2,
  zoomable: true,
  selectable: true,
});

makeBgButtons(document.getElementById('src-bg'), srcView, [0, 1, 2, 3], 3);
makeBgButtons(document.getElementById('split-prev-bg'), frameView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('merge-prev-bg'), mergeView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('conv-prev-bg'), convView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-src-bg'), nrmSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('nrm-out-bg'), nrmOutView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-src-bg'), smlSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('sml-out-bg'), smlOutView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('gif-src-bg'), gifSrcView, [0, 1, 2], 2);
makeBgButtons(document.getElementById('gv-prev-bg'), gvView, [0, 1, 2], 2);
makeCssBgButtons(
  document.getElementById('gif-prev-bg'),
  document.getElementById('gif-prev-wrap'),
  [0, 1, 2],
  2
);

// GIF 结果预览只有一张 canvas（播放和逐帧都画它），缩放平移只能走 CSS 变量
const gifWrap = document.getElementById('gif-prev-wrap');
const gifFrame = document.getElementById('gif-frame');
const gifZp = makeZoomPan(
  gifWrap,
  () => {
    // 隐藏时 canvas 还是默认的 300x150 空位，不能拿它当图像尺寸
    const nw = gifFrame.hidden ? 0 : gifFrame.width;
    const nh = gifFrame.hidden ? 0 : gifFrame.height;
    const boxW = gifWrap.clientWidth;
    const boxH = gifWrap.clientHeight;
    // object-fit: scale-down 的「适配」只缩不放，基准倍率封顶 1
    return { boxW, boxH, s0: nw && nh && boxW && boxH ? Math.min(1, boxW / nw, boxH / nh) : 0 };
  },
  (st) => {
    gifWrap.style.setProperty('--zz', String(st.zoom));
    gifWrap.style.setProperty('--zpx', `${st.panX}px`);
    gifWrap.style.setProperty('--zpy', `${st.panY}px`);
  }
);

makeViewTools(document.getElementById('split-prev-bg'), frameView);
makeViewTools(document.getElementById('merge-prev-bg'), mergeView);
makeViewTools(document.getElementById('conv-prev-bg'), convView);
makeViewTools(document.getElementById('nrm-out-bg'), nrmOutView);
makeViewTools(document.getElementById('sml-out-bg'), smlOutView);
makeViewTools(document.getElementById('gif-prev-bg'), gifZp);
makeViewTools(document.getElementById('gv-prev-bg'), gvView);

const splitApi = initSplit({ srcView, frameView });
const mergeApi = initMerge({ mergeView });
const convApi = initConvert({ view: convView });
const nrmApi = initNormal({ srcView: nrmSrcView, outView: nrmOutView });
const smlApi = initSeamless({ srcView: smlSrcView, outView: smlOutView });
const gifApi = initGif({ srcView: gifSrcView });
const gvApi = initGifView({ view: gvView });
const videoApi = initVideoConvert();
const audioApi = initAudioConvert();
const dlApi = initVideoDownload();
const pdfApi = initPdfPage();
const wordApi = initPdfPage({ word: true });
initSysInfo();
const shutdownApi = initShutdown();
initFlipClock();
const flowmapApi = initFlowmap();
const modelApi = initModelPage();
const renameApi = initRenamePage();

// 两行封顶的那几行（各页状态行、GIF 页信息行）只显示两行，超出省略号；
// 完整文字挂到 title 上，鼠标悬停看全文
for (const el of document.querySelectorAll('.status, #gif-info')) {
  const sync = () => {
    el.title = el.textContent || '';
  };
  new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
  sync();
}

const tabs = [
  ['split', tabSplit, pageSplit, [srcView, frameView]],
  ['merge', tabMerge, pageMerge, [mergeView]],
  ['convert', tabConvert, pageConvert, [convView]],
  ['normal', tabNormal, pageNormal, [nrmSrcView, nrmOutView]],
  ['seamless', tabSeamless, pageSeamless, [smlSrcView, smlOutView]],
  ['sftex', tabSftex, pageSftex, []],
  ['flowmap', tabFlowmap, pageFlowmap, []],
  ['model', tabModel, pageModel, [modelApi]],
  ['gif', tabGif, pageGif, [gifSrcView]],
  ['gifview', tabGifView, pageGifView, [gvView]],
  ['video', tabVideo, pageVideo, []],
  ['audio', tabAudio, pageAudio, []],
  ['dl', tabDl, pageDl, []],
  ['pdf', tabPdf, pagePdf, []],
  ['word', tabWord, pageWord, []],
  ['clock', tabClock, pageClock, []],
  ['rename', tabRename, pageRename, [renameApi]],
  ['sysinfo', tabSysInfo, pageSysInfo, []],
  ['diskmon', tabDiskmon, pageDiskmon, []],
  ['shutdown', tabShutdown, pageShutdown, []],
];

// 页签行的两块「药丸」:.tab-ind 标当前页签,.tab-hover 跟手做悬停底色
const tabsRow = document.querySelector('.tabs');
const tabInd = document.getElementById('tab-ind');
const tabHover = document.getElementById('tab-hover');

// 指示块跟着当前页签走。位置一次性读成整数 px,剩下的补间交给 CSS
function syncTabIndicator() {
  const el = tabsRow && tabsRow.querySelector('.tab.active');
  if (!el) return;
  placePill(tabInd, el);
  tabInd.classList.add('on');
  // 只有真的一排放不下，才把光标提示成「可以拖着走」；宽窗口下别乱指
  tabsRow.classList.toggle('scrollable', tabsRow.scrollWidth - tabsRow.clientWidth >= 1);
}

function showTab(which) {
  // 切过的页签记一笔：「按最近使用」靠它排
  markUsed(which);
  // 跳到被工具列表收起来的页签（比如关窗被拦下后跳自动关机），先把它放回来，
  // 否则切过去只有一页内容、行上却找不到对应的页签
  unhideTab(which);
  let active = tabs[0];
  for (const t of tabs) {
    const on = t[0] === which;
    t[1].classList.toggle('active', on);
    t[2].classList.toggle('hidden', !on);
    if (on) active = t;
  }
  // 窄窗口下页签一排放不下，被程序切过去的那一页（比如关窗拦截跳到自动关机）可能在可视范围外
  active[1].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncTabIndicator();
  requestAnimationFrame(() => active[3].forEach((v) => v.redraw()));
  // 第一次进这个页签才加载 iframe，避免启动时就分配那几张 8K 画布
  if (which === 'sftex') sftexApi.activate();
}

tabSplit.addEventListener('click', () => showTab('split'));
tabMerge.addEventListener('click', () => showTab('merge'));
tabConvert.addEventListener('click', () => showTab('convert'));
tabNormal.addEventListener('click', () => showTab('normal'));
tabSeamless.addEventListener('click', () => showTab('seamless'));
tabSftex.addEventListener('click', () => showTab('sftex'));
tabFlowmap.addEventListener('click', () => showTab('flowmap'));
tabModel.addEventListener('click', () => showTab('model'));
tabGif.addEventListener('click', () => showTab('gif'));
tabGifView.addEventListener('click', () => showTab('gifview'));
tabVideo.addEventListener('click', () => showTab('video'));
tabAudio.addEventListener('click', () => showTab('audio'));
tabDl.addEventListener('click', () => showTab('dl'));
tabPdf.addEventListener('click', () => showTab('pdf'));
tabWord.addEventListener('click', () => showTab('word'));
tabClock.addEventListener('click', () => showTab('clock'));
tabRename.addEventListener('click', () => showTab('rename'));
tabSysInfo.addEventListener('click', () => showTab('sysinfo'));
tabDiskmon.addEventListener('click', () => showTab('diskmon'));
tabShutdown.addEventListener('click', () => showTab('shutdown'));

// 页签微交互:悬停时半透明块跟手、点击出涟漪、按下回弹(回弹在 CSS 的 :active 里)
for (const [, tabEl] of tabs) {
  tabEl.addEventListener('mouseenter', () => {
    // 当前页签已经有 .tab-ind 打底了,别再叠一层悬停块
    if (tabEl.classList.contains('active')) {
      tabHover.classList.remove('on');
      return;
    }
    placePill(tabHover, tabEl);
    tabHover.classList.add('on');
  });
  tabEl.addEventListener('click', (ev) => ripple(tabEl, ev));
}
tabsRow.addEventListener('mouseleave', () => tabHover.classList.remove('on'));

// 滚轮落到页签行时当横向滑动用（行的纵向溢出被 overflow-y:hidden 关掉了）
tabsRow.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || !e.deltaY) return;
    tabsRow.scrollLeft += e.deltaY;
  },
  { passive: true }
);

// 左键按住页签行：横向拖 = 滚动看后面的页签，竖向拖 = 把这一页抓起来换位置。
// 一次按下只认一个手势：先动到哪个方向（超过 DRAG_BREAK）就定下来，中途不再改主意。
// 这里不用 setPointerCapture：capture 一旦设在这行上，浏览器会把 click 也派发到这行，
// 页签就再也收不到点击（窄窗口下等于点不动页签）；改成拖动期间临时挂到 window 上监听
const ORDER_KEY = 'tabOrder';
const SORT_KEY = 'tabSortMode';
const RECENT_KEY = 'tabLastUsed';
const DRAG_BREAK = 6;
let drag = null;

// 代码里声明的次序：「恢复默认顺序」按它排，和用户后来怎么拖无关
const DEFAULT_ORDER = tabs.map((t) => t[0]);

// 排序方式：custom 自定义(拖出来的次序) / name 按名称 / recent 按最近使用 / default 恢复默认
let sortMode = readSortMode();

function readSortMode() {
  try {
    const m = localStorage.getItem(SORT_KEY);
    return ['custom', 'name', 'recent', 'default'].includes(m) ? m : 'custom';
  } catch (e) {
    return 'custom';
  }
}

function saveSortMode() {
  try {
    localStorage.setItem(SORT_KEY, sortMode);
  } catch (e) {
    // 写不进去就算了，下次还是按上次的次序来
  }
}

// 哪些页签最近切过、什么时候切的：「按最近使用」靠它排
const lastUsed = readLastUsed();

function readLastUsed() {
  try {
    const o = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

function markUsed(name) {
  lastUsed[name] = Date.now();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(lastUsed));
  } catch (e) {
    // 记不住就在本次会话里生效
  }
}

// 名称排序交给 Intl：中文按拼音排，不用自己维护拼音表
const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function tabName(t) {
  return t[1].textContent.trim();
}

function readTabOrder() {
  try {
    const arr = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    const order = arr.filter((name) => tabs.some((tab) => tab[0] === name));
    // 首次加入 Word 页时，跟随已有的 PDF 页，保留用户对其他页签的排序。
    const pdfIndex = order.indexOf('pdf');
    if (pdfIndex >= 0 && !order.includes('word')) order.splice(pdfIndex + 1, 0, 'word');
    // 首次加入「科幻纹理生成」时跟在无缝贴图后面，别被挤到最末尾
    const seamlessIndex = order.indexOf('seamless');
    if (seamlessIndex >= 0 && !order.includes('sftex')) order.splice(seamlessIndex + 1, 0, 'sftex');
    return order;
  } catch (e) {
    return [];
  }
}

function saveTabOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(tabs.map((t) => t[0])));
  } catch (e) {
    // 写不进去就算了，顺序丢一次不影响功能
  }
}

// 数组跟着 DOM 重排：工具列表、启动落点、showTab 都按这个顺序说话
function sortTabsByDom() {
  tabs.sort((a, b) => (a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// 当前排序方式下，页签应该是什么次序
function orderedTabs() {
  const arr = tabs.slice();
  if (sortMode === 'name') {
    arr.sort((a, b) => nameCollator.compare(tabName(a), tabName(b)));
  } else if (sortMode === 'recent') {
    // 没用过的排后面；同一档按名称排，次序才不会乱跳
    arr.sort(
      (a, b) =>
        (lastUsed[b[0]] || 0) - (lastUsed[a[0]] || 0) ||
        nameCollator.compare(tabName(a), tabName(b))
    );
  } else if (sortMode === 'default') {
    arr.sort((a, b) => DEFAULT_ORDER.indexOf(a[0]) - DEFAULT_ORDER.indexOf(b[0]));
  } else {
    // 自定义：先走存下来的次序，没存过的接在后面
    const saved = readTabOrder();
    arr.sort((a, b) => {
      const ia = saved.indexOf(a[0]);
      const ib = saved.indexOf(b[0]);
      if (ia === ib) return 0;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }
  return arr;
}

function applyTabOrder() {
  for (const t of orderedTabs()) tabsRow.appendChild(t[1]);
  sortTabsByDom();
}

function reorderUnder(x) {
  const grabbed = drag.tab;
  let ref = null;
  for (const s of tabsRow.querySelectorAll('.tab')) {
    if (s === grabbed || s.hidden) continue;
    const b = s.getBoundingClientRect();
    if (x < b.left + b.width / 2) {
      ref = s;
      break;
    }
  }
  if (ref) {
    if (grabbed.nextElementSibling !== ref) tabsRow.insertBefore(grabbed, ref);
  } else if (grabbed !== tabsRow.lastElementChild) tabsRow.appendChild(grabbed);
  syncTabIndicator();
}

// 抓着一页拖到行的两端时，行自己往那边挪一点：不然窄窗口下永远拖不到最前面
function autoScrollAt(x) {
  const b = tabsRow.getBoundingClientRect();
  const edge = 34;
  if (x < b.left + edge) tabsRow.scrollLeft -= 12;
  else if (x > b.right - edge) tabsRow.scrollLeft += 12;
}

function onTabDragMove(e) {
  if (!drag) return;
  // 手已经离开窗口、按键在别处松掉这一轮时，e.buttons 会是 0：当作松手收尾，别把 grabbing 卡住
  if (e.buttons === 0) return endTabDrag();
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.kind) {
    if (drag.tab && Math.abs(dy) >= DRAG_BREAK && Math.abs(dy) > Math.abs(dx)) drag.kind = 'reorder';
    else if (drag.canScroll && Math.abs(dx) >= DRAG_BREAK) drag.kind = 'scroll';
    else return;
    drag.moved = true;
    tabsRow.classList.add(drag.kind === 'reorder' ? 'reordering' : 'dragging');
    if (drag.kind === 'reorder') drag.tab.classList.add('grabbed');
  }
  if (drag.kind === 'scroll') {
    tabsRow.scrollLeft = drag.left - dx;
    return;
  }
  reorderUnder(e.clientX);
  autoScrollAt(e.clientX);
}

function endTabDrag() {
  drag && window.removeEventListener('pointermove', onTabDragMove);
  window.removeEventListener('pointerup', endTabDrag);
  window.removeEventListener('pointercancel', endTabDrag);
  tabsRow.classList.remove('dragging');
  if (drag && drag.kind === 'reorder') {
    tabsRow.classList.remove('reordering');
    drag.tab.classList.remove('grabbed');
    sortTabsByDom();
    saveTabOrder();
    syncTabIndicator();
    // 手动拖过就是自定义次序，别再被「按名称」这类排序盖回去
    if (sortMode !== 'custom') setSortMode('custom', '已改为自定义顺序');
  }
}

tabsRow.addEventListener('pointerdown', (e) => {
  // 每按下一次都重新记一轮：上一轮的 moved 标记不能一直管着后面的点击
  drag = null;
  if (e.button !== 0) return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    left: tabsRow.scrollLeft,
    tab: e.target instanceof Element ? e.target.closest('.tab') : null,
    canScroll: tabsRow.scrollWidth - tabsRow.clientWidth >= 1,
    kind: null,
    moved: false,
  };
  window.addEventListener('pointermove', onTabDragMove);
  window.addEventListener('pointerup', endTabDrag);
  window.addEventListener('pointercancel', endTabDrag);
});
// 松手补发的那次 click 会被浏览器当成「点了某个页签」，拖过就别让它冒到页签上
tabsRow.addEventListener(
  'click',
  (e) => {
    if (!drag || !drag.moved) return;
    e.stopPropagation();
    e.preventDefault();
  },
  true
);

applyTabOrder();

// ===== 工具列表：手动隐藏 / 显示页签 =====
// 只在页签行上做显示与否，持久化到本地；各页自己的功能、状态都不碰
const tlBtn = document.getElementById('tool-list');
const tlPop = document.getElementById('tool-list-pop');
const tlList = document.getElementById('tlist-list');
const tlNote = document.getElementById('tlist-note');
const tlShowAll = document.getElementById('tlist-show-all');
const tlSort = document.getElementById('tlist-sort');
const tlMenu = document.getElementById('tlist-menu');
const TL_KEY = 'hiddenTabs';
const hiddenTabs = new Set(readHiddenTabs());

function readHiddenTabs() {
  try {
    const arr = JSON.parse(localStorage.getItem(TL_KEY) || '[]');
    // 只认现在还在的页签名：以后改名或删工具，旧记录自然失效
    return Array.isArray(arr) ? arr.filter((n) => tabs.some((t) => t[0] === n)) : [];
  } catch (e) {
    return [];
  }
}

function saveHiddenTabs() {
  try {
    localStorage.setItem(TL_KEY, JSON.stringify([...hiddenTabs]));
  } catch (e) {
    // 隐私模式之类写不进去就算了，别拦住页签切换
  }
}

function setTlNote(msg) {
  tlNote.textContent = msg || '';
}

function applyHiddenTabs() {
  for (const [name, tabEl] of tabs) tabEl.hidden = hiddenTabs.has(name);
  const active = tabsRow.querySelector('.tab.active');
  if (active && active.hidden) {
    const next = tabs.find((t) => !t[1].hidden);
    showTab(next[0]);
    setTlNote(`当前页已隐藏，切到「${next[1].textContent}」`);
  } else {
    syncTabIndicator();
  }
}

function unhideTab(name) {
  if (!hiddenTabs.has(name)) return;
  hiddenTabs.delete(name);
  saveHiddenTabs();
  applyHiddenTabs();
}

// 面板每次展开都照当前状态重建，省掉「勾了一个要回头同步另一处」的簿记
function buildTlList() {
  tlList.innerHTML = '';
  for (const [name, tabEl] of orderedTabs()) {
    const row = document.createElement('div');
    row.className = 'tlist-item';
    row.dataset.tab = name;

    // 拖动把手：列表里按住它上下拖，页签行跟着换位置
    const grip = document.createElement('span');
    grip.className = 'tlist-grip';
    grip.title = '拖动调整顺序';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `tl-chk-${name}`;
    box.checked = !hiddenTabs.has(name);
    box.addEventListener('change', () => {
      if (!box.checked && tabs.length - hiddenTabs.size <= 1) {
        // 全关掉等于把应用关成空白页：拦下来说明原因，不替他改别的页签
        box.checked = true;
        setTlNote('至少要留一个显示的页签');
        return;
      }
      setTlNote('');
      if (box.checked) hiddenTabs.delete(name);
      else hiddenTabs.add(name);
      saveHiddenTabs();
      applyHiddenTabs();
    });
    const label = document.createElement('label');
    label.htmlFor = box.id;
    label.textContent = tabEl.textContent;
    row.append(grip, box, label);
    tlList.appendChild(row);
  }
}

// ===== 列表里拖动：换页签的次序 =====
// 拖的是列表，页签行跟着换；拖完存下来，下次打开还是这个次序
let listDrag = null;

// 按下把手：先记下每行现在的位置。
// 插入位置按这份「按下时的快照」算，不按会动的实时位置——指针来回微动时落点才不会跟着跳
function startListDrag(row, e) {
  const rows = [...tlList.querySelectorAll('.tlist-item')];
  const rects = rows.map((r) => r.getBoundingClientRect());
  const idx = rows.indexOf(row);
  listDrag = {
    row,
    idx,
    rects,
    others: rows.filter((r) => r !== row),
    otherRects: rects.filter((_, i) => i !== idx),
    height: rects[idx].height,
    grabOffset: e.clientY - rects[idx].top,
    startY: e.clientY,
    dropIndex: -1,
    moved: false,
  };
  // 按下就弹起来：放大 + 投影，过渡写在 CSS 里
  row.classList.add('dragging');
  window.addEventListener('pointermove', onListDragMove);
  window.addEventListener('pointerup', endListDrag);
  window.addEventListener('pointercancel', endListDrag);
}

function onListDragMove(e) {
  const d = listDrag;
  if (!d) return;
  if (!d.moved) {
    if (Math.abs(e.clientY - d.startY) < DRAG_BREAK) return;
    d.moved = true;
    tlList.classList.add('reordering');
  }
  // 整行跟着鼠标走：抓取点保持在指下（用独立的 translate 属性，放大不会把它一起缩放）
  d.row.style.translate = `0 ${e.clientY - d.grabOffset - d.rects[d.idx].top}px`;
  const j = dropIndexAt(d, e.clientY);
  if (j !== d.dropIndex) {
    d.dropIndex = j;
    applyDropShift(d, j);
  }
}

// 指针落在第几行下面 → 插到第几位（去掉被拖的那行之后的序号）
function dropIndexAt(d, y) {
  for (let i = 0; i < d.otherRects.length; i++) {
    const r = d.otherRects[i];
    if (y < r.top + r.height / 2) return i;
  }
  return d.otherRects.length;
}

// 让位：插到点后面的行往下挪一行，原本在它后面、现在被让到前面的行往上挪一行
function shiftFor(d, i, j) {
  if (i < d.idx) return i >= j ? d.height : 0;
  return i >= j ? 0 : -d.height;
}

function applyDropShift(d, j) {
  for (let i = 0; i < d.others.length; i++) {
    const shift = shiftFor(d, i, j);
    d.others[i].style.translate = shift ? `0 ${shift}px` : '0 0px';
  }
}

function endListDrag() {
  window.removeEventListener('pointermove', onListDragMove);
  window.removeEventListener('pointerup', endListDrag);
  window.removeEventListener('pointercancel', endListDrag);
  const d = listDrag;
  listDrag = null;
  if (!d) return;
  tlList.classList.remove('reordering');
  if (!d.moved) {
    // 只是按了一下把手：原样弹回去
    d.row.classList.remove('dragging');
    d.row.style.translate = '';
    return;
  }
  // 记住它现在停在屏幕上的哪儿
  const beforeRect = d.row.getBoundingClientRect();
  // 别的行：让位后的落点已经是最终落点，位移直接抹掉（不补间，否则会先跳一下）
  for (const row of d.others) {
    row.style.transition = 'none';
    row.style.translate = '0 0px';
  }
  // 被拖的行挪到最终位置
  const after = d.dropIndex < d.others.length ? d.others[d.dropIndex] : null;
  if (after) tlList.insertBefore(d.row, after);
  else tlList.appendChild(d.row);
  // 先把它按回刚才的位置，再补间回槽位，同时缩回原样
  d.row.style.transition = 'none';
  d.row.style.translate = '0 0px';
  const slotRect = d.row.getBoundingClientRect();
  d.row.style.translate = `0 ${beforeRect.top - slotRect.top}px`;
  d.row.getBoundingClientRect(); // 强制回流，让浏览器认下这个起点
  d.row.style.transition =
    'translate 240ms var(--ease-out), scale 200ms var(--ease-out), box-shadow 180ms ease';
  d.row.style.translate = '0 0px';
  d.row.classList.remove('dragging');
  setTimeout(() => {
    for (const row of d.others) row.style.transition = '';
    d.row.style.transition = '';
  }, 320);
  commitListOrder();
}

// 列表现在的次序就是新的页签次序：写回页签行并存下来
function commitListOrder() {
  const names = [...tlList.querySelectorAll('.tlist-item')].map((r) => r.dataset.tab);
  for (const name of names) {
    const t = tabs.find((x) => x[0] === name);
    if (t) tabsRow.appendChild(t[1]);
  }
  sortTabsByDom();
  saveTabOrder();
  // 手动拖过就是自定义次序（列表已经是这个次序了，不用重建，免得打断落位动画）
  if (sortMode !== 'custom') {
    sortMode = 'custom';
    saveSortMode();
    syncSortMenu();
    setTlNote('已改为自定义顺序');
  }
}

// 只有按住把手才能拖：不然会跟勾选框抢点击
tlList.addEventListener('pointerdown', (e) => {
  const grip = e.target instanceof Element ? e.target.closest('.tlist-grip') : null;
  if (!grip) return;
  const row = grip.closest('.tlist-item');
  if (!row) return;
  e.preventDefault();
  startListDrag(row, e);
});

// ===== 排序方式菜单 =====
const SORT_NOTE = {
  custom: '拖动列表左侧把手即可调整顺序',
  name: '已按名称（拼音）排序',
  recent: '已按最近使用排序',
  default: '已恢复默认顺序',
};

// 换排序方式：页签行、列表、菜单三处一起对齐
function setSortMode(mode, note) {
  sortMode = mode;
  saveSortMode();
  applyTabOrder();
  syncTabIndicator();
  buildTlList();
  syncSortMenu();
  setTlNote(note || '');
}

// 菜单里的勾跟着当前方式走
function syncSortMenu() {
  for (const item of tlMenu.querySelectorAll('.tlist-menu-item')) {
    item.setAttribute('aria-checked', String(item.dataset.mode === sortMode));
  }
}

function openSortMenu(open) {
  tlMenu.hidden = !open;
  tlSort.setAttribute('aria-expanded', String(open));
  if (open) syncSortMenu();
}

tlSort.addEventListener('click', () => openSortMenu(tlMenu.hidden));
tlMenu.addEventListener('click', (e) => {
  const item = e.target instanceof Element ? e.target.closest('.tlist-menu-item') : null;
  if (!item) return;
  openSortMenu(false);
  setSortMode(item.dataset.mode, SORT_NOTE[item.dataset.mode]);
});
// 点面板里菜单以外的地方，菜单先收起来（点「排序」钮本身不算，它自己管开关）
tlPop.addEventListener('pointerdown', (e) => {
  if (tlMenu.hidden) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && (t.closest('.tlist-menu') || t.closest('#tlist-sort'))) return;
  openSortMenu(false);
});

function openTl(open) {
  tlPop.hidden = !open;
  tlBtn.classList.toggle('on', open);
  tlBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    // 「按最近使用」这类次序会随使用变化，展开时按最新状态重排一次
    applyTabOrder();
    syncTabIndicator();
    buildTlList();
    syncSortMenu();
    setTlNote('');
  } else {
    openSortMenu(false);
  }
}

tlBtn.addEventListener('click', () => openTl(tlPop.hidden));
tlShowAll.addEventListener('click', () => {
  hiddenTabs.clear();
  saveHiddenTabs();
  setTlNote('');
  buildTlList();
  applyHiddenTabs();
});
// 点面板外的任何地方都收起它；Esc 同理
document.addEventListener('pointerdown', (e) => {
  if (tlPop.hidden) return;
  const t = e.target;
  // 目标不是元素（合成事件落在 document 上）时不当作「点了外面」：
  // 否则面板刚展开就被收掉，用户看着像按钮失灵
  if (!(t instanceof Element) || t.closest('.tlist-wrap')) return;
  openTl(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tlPop.hidden) openTl(false);
});

applyHiddenTabs();

// 窗口尺寸变了、字体加载完了都重新量一次位置
addEventListener('resize', syncTabIndicator);
new ResizeObserver(syncTabIndicator).observe(tabsRow);
if (document.fonts) document.fonts.ready.then(syncTabIndicator).catch(() => {});

// 首帧先无动画地就位,再加上 .ready 打开过渡:否则启动瞬间指示块会从左上角滑过来
requestAnimationFrame(() => {
  syncTabIndicator();
  tabsRow.classList.add('ready');
});

// 标题栏：置顶 / 最小化 / 最大化 / 关闭（浏览器预览里没有窗口，整组禁用）
const pinBtn = document.getElementById('pin-top');
const pinLine = pinBtn.querySelector('.ic-pin-line');
const pinSolid = pinBtn.querySelector('.ic-pin-solid');
const pinIcon = pinBtn.querySelector('.pin-ic');
const winMin = document.getElementById('win-min');
const winMax = document.getElementById('win-max');
const winClose = document.getElementById('win-close');
const maxIcon = winMax.querySelector('.ic-max');
const restoreIcon = winMax.querySelector('.ic-restore');
const currentWindow = isTauri ? window.__TAURI__.window.getCurrentWindow() : null;

if (!currentWindow) {
  for (const b of [pinBtn, winMin, winMax, winClose]) b.disabled = true;
} else {
  pinBtn.addEventListener('click', (ev) => {
    const on = !pinBtn.classList.contains('on');
    pinBtn.classList.toggle('on', on);
    pinBtn.setAttribute('aria-pressed', String(on));
    pinBtn.setAttribute('aria-label', on ? '取消置顶' : '窗口置顶');
    pinBtn.dataset.tip = on ? '取消置顶' : '窗口置顶';
    pinLine.toggleAttribute('hidden', on);
    pinSolid.toggleAttribute('hidden', !on);
    popOnce(pinIcon, 'pop');
    ripple(pinBtn, ev);
    currentWindow.setAlwaysOnTop(on);
  });

  winMin.addEventListener('click', () => currentWindow.minimize());
  winMax.addEventListener('click', () => currentWindow.toggleMaximize());
  // 自动关机计时中关掉窗口就等于计划作废（计时只在软件内守）。第一次点先拦下来，
  // 切到那一页把原因写在状态行，再点一次才真关 —— 免得手滑把排好的关机弄没了
  let closeBlockedAt = 0;
  winClose.addEventListener('click', () => {
    if (shutdownApi.blocksClose() && Date.now() - closeBlockedAt > 5000) {
      closeBlockedAt = Date.now();
      showTab('shutdown');
      shutdownApi.reportCloseBlocked();
      return;
    }
    currentWindow.close();
  });

  // 最大化 / 还原后换图标，拖动窗口改变尺寸时也会触发
  const syncMaxIcon = async () => {
    const maximized = await currentWindow.isMaximized();
    maxIcon.toggleAttribute('hidden', maximized);
    restoreIcon.toggleAttribute('hidden', !maximized);
    winMax.setAttribute('aria-label', maximized ? '还原' : '最大化');
    winMax.title = maximized ? '还原' : '最大化';
  };
  syncMaxIcon();
  currentWindow.onResized(() => syncMaxIcon());
}

// 浅色 / 深色主题：默认深色，选择记入 localStorage；head 内联脚本会在启动时提前恢复
const themeBtn = document.getElementById('theme-toggle');
const icMoon = themeBtn.querySelector('.ic-moon');
const icSun = themeBtn.querySelector('.ic-sun');
function swapThemeIcon(light) {
  // 注意:SVG 元素上的 .hidden IDL 属性在 WebView2 里不会可靠反映到 content attribute,
  // 必须直接切属性,[hidden]{display:none} 才能命中
  icMoon.toggleAttribute('hidden', light); // 浅色下显示太阳(点一下回深色)
  icSun.toggleAttribute('hidden', !light);
}

// syncIcon=false 时只换底色不换图标,用于「旋钮转到一半再翻面」的节奏
function applyTheme(theme, syncIcon = true) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('light', light);
  themeBtn.dataset.tip = light ? '当前浅色，点击切换深色' : '当前深色，点击切换浅色';
  themeBtn.setAttribute('aria-pressed', String(light));
  // 让系统的非客户区(边框、原生对话框)也跟着换,避免浅色窗口配深色系统框
  if (currentWindow) currentWindow.setTheme(light ? 'light' : 'dark').catch(() => {});
  if (syncIcon) swapThemeIcon(light);
}
applyTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');

let themeIconTimer = 0;
themeBtn.addEventListener('click', (ev) => {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  popOnce(themeBtn, 'spin');
  ripple(themeBtn, ev);
  if (prefersReduced()) {
    applyTheme(next);
  } else {
    // 底色立刻跟着换,图标推迟到旋钮转到一半时再翻面,看着像同一只在转
    applyTheme(next, false);
    clearTimeout(themeIconTimer);
    themeIconTimer = setTimeout(() => swapThemeIcon(next === 'light'), 300);
  }
  // 画布上的棋盘格/底色是 JS 绘制的,通知各 CanvasView 重画
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
});

onGlobalDrop((entries) => {
  // 科幻纹理生成是独立 iframe，不吃宿主的拖放；不拦住的话会误落到「序列图合并」
  if (!pageSftex.classList.contains('hidden')) return;
  // 批量重命名页：接受任意文件 / 文件夹，谁在前台就交给谁（放最前，类型不再过滤）
  if (!pageRename.classList.contains('hidden')) {
    renameApi.importPaths(entries);
    return;
  }
  if (!pageWord.classList.contains('hidden')) {
    wordApi.addEntries(entries);
    return;
  }
  // PDF 转图片页：一次只吃一个 PDF
  if (!pagePdf.classList.contains('hidden')) {
    pdfApi.addEntries(entries);
    return;
  }
  // 音频转换页优先吃音频/视频（批量模式下整批收进待转换列表）
  if (!pageAudio.classList.contains('hidden')) {
    audioApi.addEntries(entries);
    return;
  }
  // 视频转换页优先吃视频（批量模式下整批收进待转换列表）
  if (!pageVideo.classList.contains('hidden')) {
    videoApi.addEntries(entries);
    return;
  }
  // 模型预览页：拖入的 3D 模型，同批文件当作外部贴图 / .bin / .mtl 一起收下
  if (!pageModel.classList.contains('hidden')) {
    const main = entries.find((e) => isModelName(e.name)) || entries[0];
    modelApi.loadEntry(main, entries.filter((e) => e !== main));
    return;
  }
  // Flowmap 绘制页：拖入的图片当作底图载入
  if (!pageFlowmap.classList.contains('hidden')) {
    flowmapApi.loadEntry(entries[0]);
    return;
  }
  // 几个动画/贴图处理页各有一份白名单，谁在前台就交给谁（白名单外也递过去，由页面给提示）
  for (const [pageEl, api, exts] of [
    [pageGifView, gvApi, GIF_ONLY_EXTS],
    [pageGif, gifApi, GIF_SOURCE_EXTS],
    [pageSeamless, smlApi, TEXTURE_EXTS],
    [pageNormal, nrmApi, TEXTURE_EXTS],
  ]) {
    if (!pageEl.classList.contains('hidden')) {
      const ok = entries.filter((e) => isSupportedName(e.name, exts));
      api.loadEntry(ok[0] || entries[0]);
      return;
    }
  }
  if (!pageConvert.classList.contains('hidden')) {
    // 白名单外的文件也交给转换页，由它给出「不支持的格式」提示
    // 批量模式下整批收进待转换列表
    convApi.addEntries(entries);
    return;
  }
  const supported = entries.filter((e) => isSupportedName(e.name));
  if (!supported.length) return;
  if (!pageSplit.classList.contains('hidden')) {
    splitApi.loadEntry(supported[0]);
  } else {
    mergeApi.addEntries(supported);
  }
});

// WebView2 自带的那套「后退/重新加载/另存为/检查」菜单对独立工具没意义，整窗屏蔽
// 文本框里的右键粘贴一起没了，粘贴走 Ctrl+V
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 回车不再二次触发当前聚焦的按钮/页签：用鼠标点过「打开图片…」之后再敲回车，
// 原来会把那个按钮再按一次。输入框里的回车是各页自己的功能（解析链接、收时间框），照旧放行。
// F3（查找下一个）/ F7（插入点浏览）即便浏览器加速键在 Rust 侧被关掉，
// 按键仍会落到页面并把 WebView 切成「键盘焦点」模式：按钮冒出白色焦点框、
// 页签冒出蓝色焦点框。在捕获阶段直接吃掉，配合 styles.css 末尾的全局 outline 规则。
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'F3' || e.key === 'F7') {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// 浏览器快捷键（F1/F3/F5/F7、Ctrl+F/P/S/O…）在 Rust 侧整组关掉，这里只补页面这层：
// Ctrl+滚轮缩放（zoomHotkeysEnabled 之外的兜底）
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    e.preventDefault();
  },
  true
);
addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false }
);

// 启动落在第一个没被工具列表收起来的页签上：被收掉的页签不该在重启时又被拉回这一行
showTab(tabs.find((t) => !hiddenTabs.has(t[0]))[0]);
