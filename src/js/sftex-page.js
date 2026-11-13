/*
 * 「科幻纹理生成」页：把 JSPlacementWeb 放进独立 iframe。
 *
 * 为什么用 iframe：那个应用是十年前的 Electron 代码，几十个全局变量
 * （cfg / files / gfiles / canvas / ctx / res / path / i / saveAs …）直接挂在 window 上，
 * 和工具箱其它页放一起必然打架。隔离开后，它自己的 jQuery、样式和快捷键都只在框里生效。
 *
 * 宿主这边负责三件事：
 *   1) iframe 100% 填充，框内已经改成工具箱自己的「左参数 / 右预览」响应式布局；
 *   2) 懒加载 iframe（不进这个页签就不创建），并把顶栏选择的尺寸传进去；
 *   3) 顶栏「导出」让 iframe 把当前预览的画布（高度图或着色图）送进 saveAs 通道；
 *   4) 同步深 / 浅色主题，并把框内的 saveAs / 外链请求桥接到工具箱自己的通道。
 */
import { isTauri, saveBlob } from './platform.js';

const DIR_KEY = 'sftex.outDir';
const SIZE_KEY = 'sftex.size';
const SIZES = [512, 1024, 2048, 4096, 8192];

export function initSftexPage() {
  const frame = document.getElementById('sftex-frame');
  const dirBtn = document.getElementById('sftex-dir');
  const dirClear = document.getElementById('sftex-dir-clear');
  const dirLabel = document.getElementById('sftex-dir-label');
  const reloadBtn = document.getElementById('sftex-reload');
  const guideBtn = document.getElementById('sftex-guide');
  const exportBtn = document.getElementById('sftex-export');
  const sizeSel = document.getElementById('sftex-size');
  const navButtons = document.querySelectorAll('#sftex-head [data-sf-page]');
  const status = document.getElementById('sftex-status');

  let size = 1024;
  try {
    const stored = Number(localStorage.getItem(SIZE_KEY));
    if (SIZES.includes(stored)) size = stored;
  } catch (e) {
    /* localStorage 不可用就用默认 1024 */
  }
  sizeSel.value = String(size);

  let outDir = '';
  try {
    outDir = localStorage.getItem(DIR_KEY) || '';
  } catch (e) {
    /* localStorage 不可用就不记住目录 */
  }
  let loaded = false;
  let saving = false;
  let statusTimer = 0;
  let pendingNav = null;
  let pendingExport = false;

  function setStatus(text, ok = true) {
    status.textContent = text || '';
    status.classList.toggle('error', !ok);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => setStatus('', true), 6000);
  }

  function syncDirLabel() {
    dirLabel.textContent = outDir || '未设置（导出时询问）';
    dirLabel.title = outDir || '未设置输出目录，导出时会弹目录选择框';
    dirClear.hidden = !outDir;
  }

  // iframe 内的 embed.js 会跟着工具箱的主题切换，宿主这边负责把状态推过去
  function sendTheme() {
    try {
      frame.contentWindow?.postMessage(
        { __sftexTheme: true, light: document.documentElement.classList.contains('light') },
        '*'
      );
    } catch (e) {
      /* iframe 还没就绪，等 load 事件再发一次 */
    }
  }

  // 生成器切换按钮放在宿主顶栏，点击后让 iframe 里的 embed.js 去导航
  function postToFrame(msg) {
    try {
      frame.contentWindow?.postMessage(msg, '*');
    } catch (e) {
      /* iframe 未就绪 */
    }
  }

  function sendSize() {
    postToFrame({ __sftexSize: true, size });
  }

  function markHostPage(page) {
    navButtons.forEach((b) => b.classList.toggle('on', b.dataset.sfPage === page));
  }

  function requestNav(msg) {
    // 使用指南只是弹层，不改变当前生成器，别动按钮高亮
    if (msg.page) markHostPage(msg.page);
    // 第一次进入页签时 iframe 可能还在加载，等 load 后再把命令补发过去
    if (!loaded || frame.contentDocument?.readyState !== 'complete') {
      pendingNav = msg;
      activate();
      return;
    }
    postToFrame(msg);
  }

  frame.addEventListener('load', () => {
    sendTheme();
    sendSize();
    if (pendingNav) {
      postToFrame(pendingNav);
      pendingNav = null;
    }
    if (pendingExport) {
      postToFrame({ __sftexExport: true });
      pendingExport = false;
    }
  });
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sendTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => requestNav({ __sftexNav: true, page: btn.dataset.sfPage }));
  });
  guideBtn.addEventListener('click', () => requestNav({ __sftexNav: true, action: 'guide' }));
  exportBtn.addEventListener('click', () => {
    if (!loaded || frame.contentDocument?.readyState !== 'complete') {
      pendingExport = true;
      activate();
      setStatus('正在载入生成器，载入完成后自动导出');
      return;
    }
    setStatus('正在准备导出当前贴图…');
    postToFrame({ __sftexExport: true });
  });
  sizeSel.addEventListener('change', () => {
    const n = Number(sizeSel.value);
    if (!SIZES.includes(n)) return;
    size = n;
    try {
      localStorage.setItem(SIZE_KEY, String(n));
    } catch (e) {
      /* 记不住就本次会话有效 */
    }
    sendSize();
    setStatus('生成尺寸已设为 ' + n + ' × ' + n + '，请重新生成贴图');
  });
  markHostPage('home.html');

  function activate() {
    if (!loaded) {
      frame.src = 'jsplacement/index.html?size=' + size;
      loaded = true;
    }
  }

  dirBtn.addEventListener('click', async () => {
    if (!isTauri) {
      setStatus('桌面版才需要设置输出目录；浏览器里直接下载', false);
      return;
    }
    try {
      const picked = await window.__TAURI__.core.invoke('pick_dir');
      if (!picked) return; // 用户取消
      outDir = picked;
      try {
        localStorage.setItem(DIR_KEY, outDir);
      } catch (e) {
        /* 记不住就本次会话有效 */
      }
      syncDirLabel();
      setStatus('输出目录已设置');
    } catch (e) {
      setStatus('选择目录失败：' + (e?.message || e), false);
    }
  });

  dirClear.addEventListener('click', () => {
    outDir = '';
    try {
      localStorage.removeItem(DIR_KEY);
    } catch (e) {
      /* 忽略 */
    }
    syncDirLabel();
  });

  reloadBtn.addEventListener('click', () => {
    try {
      frame.contentWindow.location.reload();
    } catch (e) {
      frame.src = 'jsplacement/index.html';
    }
    pendingNav = null;
    pendingExport = false;
    markHostPage('home.html');
    setStatus('已重新载入');
  });

  // iframe 里的 compat.js 会把导出 / 外链通过 postMessage 送过来
  window.addEventListener('message', async (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const d = ev.data;
    if (!d) return;
    if (d.__sftexThemeQuery === true) {
      sendTheme();
      return;
    }
    // 键盘热键、iframe 内部导航都会回报当前页，宿主按钮跟着高亮
    if (d.__sftexPage === true && typeof d.page === 'string') {
      markHostPage(d.page);
      return;
    }
    // 导出前的校验结果（还没生成贴图 / 不在生成器页）
    if (d.__sftexExportStatus === true) {
      setStatus(d.text || '', d.ok !== false);
      return;
    }
    if (d.__sftex !== true) return;

    if (d.kind === 'open') {
      const url = String(d.url || '');
      if (!/^https?:\/\//i.test(url)) return;
      if (isTauri) {
        try {
          await window.__TAURI__.core.invoke('open_path', { path: url });
          return;
        } catch (e) {
          /* 打开失败就退回浏览器默认行为 */
        }
      }
      window.open(url, '_blank');
      return;
    }

    if (d.kind === 'save') {
      if (saving) {
        setStatus('上一次导出还没写完，请稍候', false);
        return;
      }
      saving = true;
      setStatus('正在写出 ' + d.name + ' …');
      try {
        const bytes = new Uint8Array(d.buffer);
        let dir = outDir;
        if (!dir && isTauri) dir = (await window.__TAURI__.core.invoke('pick_dir')) || '';
        if (isTauri && !dir) {
          setStatus('已取消保存', false);
          return;
        }
        const saved = await saveBlob(d.name, bytes, dir || null, { unique: true });
        setStatus('已保存：' + (saved || d.name));
      } catch (e) {
        setStatus('保存失败：' + (e?.message || e), false);
      } finally {
        saving = false;
      }
    }
  });

  syncDirLabel();
  return { activate };
}
