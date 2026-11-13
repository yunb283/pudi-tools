/*
 * 嵌入版的界面适配层。
 *
 * JSPlacement 的页面片段原本假设自己在 1280×800 的 Electron 窗口里，
 * 元素靠绝对定位各占一块。这里在每次 loadPage() 之后把片段重排成
 * 工具箱的「左参数 / 右预览」两栏；所有 id / onclick 都原样保留，
 * 只是把节点搬家，所以生成与导出逻辑完全不用改。
 */
(function () {
  'use strict';

  // 生成分辨率由工具箱顶栏的「尺寸」下拉框决定：首次加载走 URL 参数，之后走 postMessage
  var SIZES = [512, 1024, 2048, 4096, 8192];
  function normalizeSize(v) {
    var n = parseInt(v, 10);
    return SIZES.indexOf(n) >= 0 ? n : 1024;
  }
  var sizeParam = /[?&]size=(\d+)/.exec(window.location.search);
  window.SFTEX_RES = normalizeSize(sizeParam ? sizeParam[1] : 1024);

  var currentPage = 'home.html';
  var canvasObserver = null;

  /* ---------- 8K 画布等比预览 ---------- */

  function fitCanvas() {
    var box = document.querySelector('.canvasbox');
    var inner = document.querySelector('.canvasboxinner');
    if (!box || !inner) return;
    var side = Math.floor(Math.min(box.clientWidth, box.clientHeight)) - 8;
    if (side < 80) return;
    inner.style.width = side + 'px';
    inner.style.height = side + 'px';
  }

  function watchCanvas() {
    if (canvasObserver) {
      canvasObserver.disconnect();
      canvasObserver = null;
    }
    var box = document.querySelector('.canvasbox');
    if (!box) return;
    fitCanvas();
    if (typeof ResizeObserver !== 'undefined') {
      canvasObserver = new ResizeObserver(fitCanvas);
      canvasObserver.observe(box);
    }
    window.addEventListener('resize', fitCanvas, { once: true });
  }

  /* ---------- 把生成器片段重排成左右面板 ---------- */

  function sfLayout() {
    var c = document.getElementById('container');
    if (!c) return;

    // 已经排过版（或页面自己带了 .sf-left 骨架）就跳过，避免重复包裹
    if (c.querySelector(':scope > .sf-left')) {
      watchCanvas();
      return;
    }

    var canvasbox = c.querySelector('.canvasbox');
    if (!canvasbox) {
      // 非生成器页面：把零散内容兜底装进一个铺满的面板
      var wide = document.createElement('div');
      wide.className = 'panel sf-left sf-wide sf-doc';
      var nodes = Array.prototype.slice.call(c.children);
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].tagName !== 'SCRIPT') wide.appendChild(nodes[k]);
      }
      c.appendChild(wide);
      return;
    }

    var left = document.createElement('div');
    left.className = 'panel sf-left';
    var right = document.createElement('div');
    right.className = 'panel sf-right';

    var leftHead = document.createElement('div');
    leftHead.className = 'panel-head';
    leftHead.innerHTML =
      '<span class="panel-title">生成参数</span>' +
      '<span class="sf-hint">数字键 1–5 切换生成器 · R 重新生成</span>';
    left.appendChild(leftHead);

    var editor = c.querySelector('.editorbox');
    if (editor) left.appendChild(editor);

    var newActions = c.querySelector('.newactions');
    if (newActions) left.appendChild(newActions);

    var presets = c.querySelector('#presetlist');
    if (presets) left.appendChild(presets);

    var actions = c.querySelector('.actionbox');
    if (actions) left.appendChild(actions);

    var rightHead = document.createElement('div');
    rightHead.className = 'panel-head';
    rightHead.innerHTML =
      '<span class="panel-title">贴图预览</span>' +
      '<span class="sf-hint">' + window.SFTEX_RES + ' × ' + window.SFTEX_RES + ' · 点击画布可重新生成</span>';
    var views = canvasbox.querySelector('.viewcontrols');
    if (views) rightHead.appendChild(views);
    right.appendChild(rightHead);

    right.appendChild(canvasbox);

    var colorizer = c.querySelector('#colorizer');
    if (colorizer) right.appendChild(colorizer);

    c.appendChild(left);
    c.appendChild(right);

    // 精灵组的 <label> 写在 <input> 前面，纯 CSS 的兄弟选择器够不着；
    // 同步一个 .on 类做高亮，避免依赖 :has()（较老的 WebView2 不支持）。
    function syncRadios() {
      var boxes = c.querySelectorAll('.spriteset, .radiobox3w, .radiobox5w');
      for (var j = 0; j < boxes.length; j++) {
        var r = boxes[j].querySelector('input[type="radio"]');
        if (r) boxes[j].classList.toggle('on', !!r.checked);
      }
    }
    var radios = c.querySelectorAll('.spriteset input[type="radio"], .radiobox3w input[type="radio"], .radiobox5w input[type="radio"]');
    for (var j = 0; j < radios.length; j++) {
      radios[j].addEventListener('change', syncRadios);
    }
    syncRadios();

    watchCanvas();
  }

  window.sfLayout = sfLayout;

  /* ---------- 顶部工具条 ---------- */

  // 生成器切换按钮已经搬到宿主顶栏，这里负责把当前页回报过去同步高亮
  function notifyHost(page) {
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ __sftexPage: true, page: page }, '*');
      }
    } catch (e) {
      /* 忽略跨域 */
    }
  }

  function markActive(page) {
    var btns = document.querySelectorAll('#sf-toolbar [data-page]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-page') === page);
    }
    notifyHost(page);
  }

  function navigate(page) {
    currentPage = page;
    markActive(page);
    hideMenu();
    unload();
    loadPage(page);
  }

  $(function () {
    // 只有单独打开这个页面时才显示内置工具条；嵌在工具箱里由宿主顶栏接管
    if (window.parent === window) document.body.classList.add('sf-standalone');

    var btns = document.querySelectorAll('#sf-toolbar [data-page]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        navigate(this.getAttribute('data-page'));
      });
    }

    var guideBtn = document.getElementById('sf-btn-guide');
    if (guideBtn) guideBtn.addEventListener('click', function () { gitGuide(); });

    // 键盘热键（1–5 / H / A）走的是全局 loadPage，包一层同步工具条高亮
    var originalLoadPage = window.loadPage;
    window.loadPage = function (page) {
      currentPage = page;
      markActive(page);
      return originalLoadPage.apply(this, arguments);
    };

    markActive(currentPage);
  });

  /* ---------- 顶栏「导出」：把当前预览的那张画布送进宿主保存通道 ---------- */

  function tellHost(text, ok) {
    try {
      if (window.parent !== window) {
        window.parent.postMessage(
          { __sftexExportStatus: true, ok: ok !== false, text: text }, '*'
        );
      }
    } catch (e) {
      /* 忽略跨域 */
    }
  }

  function exportCurrent() {
    var dis = document.getElementById('dis');
    var dat = document.getElementById('dat');
    if (!dis || !dat) {
      tellHost('请先进入生成器页面再导出', false);
      return;
    }
    if (dis.getAttribute('generated') !== 'yup') {
      tellHost('请先点「生成」生成贴图，再导出', false);
      return;
    }
    // showHeight(0) / 渐变着色会给 #dis 加 hidden，此时屏幕上看到的是 #dat
    var colored = dis.classList.contains('hidden');
    var target = colored ? dat : dis;
    try {
      var center = target.getContext('2d').getImageData(
        Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1
      ).data;
      if (center[3] === 0) {
        tellHost('当前着色图还是空的，请先选一张渐变', false);
        return;
      }
    } catch (e) {
      /* 取不到像素就照常导出 */
    }

    var base = (typeof window.savename === 'string' && window.savename)
      ? window.savename : 'JS-Texture-';
    var name = base + Math.floor(Date.now() / 1000) +
      (colored ? '-Color' : '-Height') + '.png';
    try {
      target.toBlob(function (blob) {
        if (!blob) {
          tellHost('导出失败：画布编码出错', false);
          return;
        }
        tellHost('正在导出 ' + name + ' …', true);
        if (typeof window.saveAs === 'function') window.saveAs(blob, name);
      }, 'image/png');
    } catch (e) {
      tellHost('导出失败：' + (e && e.message ? e.message : e), false);
    }
  }

  /* ---------- 跟随工具箱的深 / 浅色主题 ---------- */

  function setTheme(light) {
    document.documentElement.classList.toggle('light', !!light);
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d) return;
    if (d.__sftexTheme === true) {
      setTheme(d.light);
      return;
    }
    if (d.__sftexSize === true) {
      var nextSize = normalizeSize(d.size);
      if (nextSize !== window.SFTEX_RES) {
        window.SFTEX_RES = nextSize;
        // 生成器页要重新加载片段，才能按新尺寸重建画布和坐标
        if (currentPage.indexOf('gen/') === 0) navigate(currentPage);
      }
      return;
    }
    // 宿主顶栏的「导出」：导出当前正在显示的那张图
    if (d.__sftexExport === true) {
      exportCurrent();
      return;
    }
    // 宿主顶栏的按钮：切页 / 打开使用指南
    if (d.__sftexNav === true) {
      if (d.action === 'guide') {
        if (typeof window.gitGuide === 'function') window.gitGuide();
      } else if (d.page) {
        navigate(d.page);
      }
    }
  });

  // iframe 刚创建时主动问一次，宿主会在 iframe load 后回复
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ __sftexThemeQuery: true }, '*');
    }
  } catch (e) {
    /* 忽略跨域 */
  }

  // 兜底：跟随 WebView 自身的 prefers-color-scheme（宿主没回消息时也不至于刺眼）
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    // 不立刻切：宿主几乎总会回消息，这里只在 1.2s 后仍未收到主题时生效
    var gotTheme = false;
    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.__sftexTheme === true) gotTheme = true;
    });
    setTimeout(function () { if (!gotTheme) setTheme(true); }, 1200);
  }
})();
