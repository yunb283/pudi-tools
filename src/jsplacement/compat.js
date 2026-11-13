/*
 * JSPlacementWeb -> 布丁工具箱 兼容层
 *
 * 原项目是从 Electron 版 JSPlacement 快速移植来的，源码里还留着
 * require('electron') / require('fs-extra') / require('ini') / require('*.json')
 * 以及 fs.readdirSync 等 Node 调用。这里用最小的浏览器替身把这些调用顶上，
 * 生成器本身的算法一行都不改。
 *
 * 另外，Tauri 的 WebView2 默认不处理 <a download> 的 blob 下载，
 * 所以把 saveAs 也接管过来，通过 postMessage 交给宿主用 write_file 落盘。
 */
(function () {
  'use strict';

  var CONF_KEY = 'sftex.jsplacement.conf';
  var DEFAULTS = {
    General: {
      skipSplashScreen: true,
      disableUpdateCheck: true, // 桌面版不要联网检查更新
      disableAnimations: false,
      // 原版从 ini 读出来是字符串，settings.js 的 switch 也是按字符串匹配的；
      // 默认值用数字会让首次打开设置页时「文件名示例」那一行为空
      timestampFormat: '0',
      skin: '0',
      iddqd: false,
    },
  };

  function deep(o) {
    return JSON.parse(JSON.stringify(o));
  }

  var conf = null;
  try {
    conf = JSON.parse(localStorage.getItem(CONF_KEY) || 'null');
  } catch (e) {
    conf = null;
  }
  if (!conf || !conf.General) conf = deep(DEFAULTS);

  function persist() {
    try {
      localStorage.setItem(CONF_KEY, JSON.stringify(conf));
    } catch (e) {
      /* 隐私模式写不进去就只在本次会话生效 */
    }
  }

  // config.js / settings.js 用 ini.parse + ini.stringify 读写 jsplacement.conf
  var ini = {
    parse: function () {
      return deep(conf);
    },
    stringify: function (o) {
      conf = deep(o);
      persist();
      return JSON.stringify(conf);
    },
  };

  var manifest = window.SFTEX_MANIFEST || {};

  function normalize(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/^JSplacement\//, '');
  }

  // fs.readdirSync 只被拿来列精灵/渐变素材，离线版用打包时生成的静态清单代替
  function listFor(p) {
    var k = normalize(p);
    if (/CustomSprites/i.test(k)) k = 'JS2sprites/JS2Classic';
    if (/CustomGradients/i.test(k)) k = 'Gradients';
    if (manifest[k]) return manifest[k].slice();
    var tail = k.slice(k.lastIndexOf('/') + 1);
    return (manifest[tail] || []).slice();
  }

  var fs = {
    existsSync: function () {
      return true; // 配置文件 / 用户预设都当作已存在，避免触发 copySync
    },
    copySync: function () {},
    mkdirSync: function () {},
    readFileSync: function () {
      return JSON.stringify(conf);
    },
    writeFileSync: function (_p, data) {
      try {
        var o = JSON.parse(String(data));
        if (o && o.General) {
          conf = o;
          persist();
        }
      } catch (e) {
        /* 忽略格式异常 */
      }
    },
    readdirSync: function (p) {
      return listFor(p);
    },
  };

  function toParent(msg) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
        return true;
      }
    } catch (e) {
      /* 跨域时退回本地行为 */
    }
    return false;
  }

  function openExternal(url) {
    url = String(url || '');
    if (!toParent({ __sftex: true, kind: 'open', url: url })) {
      window.open(url, '_blank');
    }
  }

  // 给 navigation.js / about.html 里的 goToPage 用（下面在 navigation.js 里改了调用）
  window.SFTEX_openExternal = openExternal;

  // 原首页右上角有「关闭窗口」按钮，嵌进工具箱后不能让它把整窗关掉
  try {
    window.close = function () {};
  } catch (e) {
    /* 只读就忽略：按钮本身已经用 CSS 隐藏了 */
  }

  var noop = function () {};
  var fakeWindow = {
    webContents: {
      session: {
        clearCache: function (cb) {
          if (typeof cb === 'function') cb();
        },
      },
    },
  };
  var electron = {
    remote: {
      app: { getPath: function () { return ''; } },
      process: {},
      getCurrentWindow: function () { return fakeWindow; },
    },
    shell: {
      showItemInFolder: noop,
      openItem: noop,
      openExternal: openExternal,
    },
  };

  window.require = function (name) {
    var n = String(name || '');
    if (n === 'electron') return electron;
    if (n === 'jquery') return window.jQuery;
    if (n === 'fs-extra' || n === 'fs') return fs;
    if (n === 'ini') return ini;
    if (n.indexOf('userpresets.json') >= 0) return (window.SFTEX_USER_PRESETS || []).slice();
    if (n.indexOf('presets.json') >= 0) return (window.SFTEX_PRESETS || []).slice();
    return {};
  };

  /*
   * filesaver.js 里是 `var saveAs = saveAs || function(){...}`，
   * 这里先定义好，原版 FileSaver 就不会覆盖我们。
   */
  window.saveAs = function (blob, name) {
    if (!blob) return;
    var filename = String(name || 'texture.png');
    if (window.parent && window.parent !== window) {
      var reader = new FileReader();
      reader.onload = function () {
        var buf = reader.result;
        var msg = { __sftex: true, kind: 'save', name: filename, buffer: buf };
        // 8K PNG 可能几十 MB，用 transfer 避免再复制一份
        try {
          window.parent.postMessage(msg, '*', [buf]);
        } catch (e) {
          window.parent.postMessage(msg, '*');
        }
      };
      reader.onerror = noop;
      reader.readAsArrayBuffer(blob);
      return;
    }
    // 单独打开 iframe 页面时的兜底：普通浏览器下载
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  };
})();
