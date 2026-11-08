// 翻页时钟页。
// 三种风格共用同一份时间状态：扁平化和立体感都是翻页卡，差别只在 CSS（有无透视、卡面渐变、翻牌时长）；
// 数字时钟走七段数码管，没有翻页，只有辉光和每秒闪一次的冒号。
// 设置收在右下角齿轮里，点舞台外的空白处缩回去。
// 这一页只读系统时间、只改显示，绝不碰电源：倒计时到点只停在 00:00:00 并提示一行，真要定时关机走「自动关机」页。
import { isTauri } from "./platform.js";

const $ = (id) => document.getElementById(id);
// 缩放默认值从 80 改成 100 时换了键名：沿用旧键的话，他之前存下来的 80 会一直压住新默认值
const KEY = "fcSettings.v2";
// 翻页时长 = 整张页走完前半程（折旧上半）+ 后半程（落新下半）的总时间。
// 参考动图有效翻页约 450ms；立体档稍慢一点让透视看得清，都要短于 1 秒不然会追不上秒针。
const FLIP_MS = { flat: 420, "3d": 560 };
// 数码管默认偏红：色轮上的角度是色相、半径是饱和度
const LED_HUE = 6;
const LED_SAT = 100;

// 七段：a 上 / b 右上 / c 右下 / d 下 / e 左下 / f 左上 / g 中
const SEG = {
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "acdefg",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
  " ": "",
};

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function initFlipClock() {
  const stage = $("fc-stage");
  const flipBox = $("fc-flip");
  const ledBox = $("fc-led");
  const merEl = $("fc-meridiem");
  const statusEl = $("fc-status");
  const pageEl = $("page-clock");
  const fullBtn = $("fc-full");
  const gearBtn = $("fc-gear");
  const pop = $("fc-pop");
  const styleBtns = [...$("fc-style").querySelectorAll("[data-style]")];
  const fmtBtns = $("fc-fmt").querySelectorAll("[data-fmt]");
  const scaleIn = $("fc-scale");
  const scaleNum = $("fc-scale-num");
  const brightIn = $("fc-bright");
  const brightNum = $("fc-bright-num");
  const bgBox = $("fc-bg");
  const secBox = $("fc-sec");
  const labelsBox = $("fc-labels");
  const swBtn = $("fc-sw");
  const wheel = $("fc-wheel");
  const knob = $("fc-knob");
  const colorRow = $("fc-color");
  const colorLab = $("fc-color-lab");
  const colorTxt = $("fc-color-txt");

  const st = {
    style: "flat",
    fmt: "24h",
    scale: 100,
    bright: 100,
    bg: true,
    sec: true,
    labels: true,
    ledH: LED_HUE,
    ledS: LED_SAT,
    mode: "clock",
    swRun: false,
    swAcc: 0,
    swStart: 0,
    cdRun: false,
    cdLeft: 0,
    cdEnd: 0,
    cdDone: false,
  };

  try {
    Object.assign(st, JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch (e) {
    // 读不到就用默认值
  }
  // 旧版存过 024h（补零的 24 小时制）；选项删掉后统一归到 24h，
  // 否则两个按钮都不亮，小时还会掉回不补零的写法
  if (st.fmt !== "12h") st.fmt = "24h";

  function persist() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          style: st.style,
          fmt: st.fmt,
          scale: st.scale,
          bright: st.bright,
          bg: st.bg,
          sec: st.sec,
          labels: st.labels,
          ledH: st.ledH,
          ledS: st.ledS,
        }),
      );
    } catch (e) {
      // 写不进去不影响这一页用
    }
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function buildTree(box) {
    box.innerHTML = "";
    const nodes = {};
    [
      ["h", "时"],
      ["m", "分"],
      ["s", "秒"],
    ].forEach(([k, lbl], i) => {
      if (i) box.appendChild(el("div", "fc-colon", ":"));
      const grp = el("div", "fc-grp");
      const cells = el("div", "fc-cells");
      grp.append(cells, el("div", "fc-lbl", lbl));
      box.appendChild(grp);
      nodes[k] = { grp, cells };
    });
    return nodes;
  }

  const flip = buildTree(flipBox);
  const led = buildTree(ledBox);

  function makeCard() {
    const c = el("div", "fc-card");
    c.append(
      el("span", "fc-h fc-top", "<i></i>"),
      el("span", "fc-h fc-bot", "<i></i>"),
      el("span", "fc-h fc-ft", "<i></i>"),
      el("span", "fc-h fc-fb", "<i></i>"),
    );
    c._v = null;
    return c;
  }

  function makeSeg() {
    const d = el("div", "fc-seg");
    for (const s of "abcdefg") {
      const b = el("b");
      b.dataset.s = s;
      d.appendChild(b);
    }
    d._v = null;
    return d;
  }

  // 一张翻页卡里四层的关系（children 顺序见 makeCard）：
  //   [0] .fc-top 静止上半 = 新数字，被翻页正面盖住，折多少露多少
  //   [1] .fc-bot 静止下半 = 旧数字，整段动画都不变，落地那一刻才换
  //   [2] .fc-ft  翻页正面 = 旧数字上半，绕中线向下折 0° → -90°
  //   [3] .fc-fb  翻页背面 = 新数字下半，从 90° 落到 0°，由中线往下盖住旧下半
  // 旧写法把静止下半一开始就写成新数字，于是上下两半显示成两个不同的数；
  // 扁平档还让下半翻的是旧数字、方向朝外，跟参考动图正好相反。
  function setCard(c, ch) {
    if (c._v === ch) return;
    const prev = c._v;
    c._v = ch;
    const top = c.children[0].firstChild;
    const bot = c.children[1].firstChild;
    const ft = c.children[2].firstChild;
    const fb = c.children[3].firstChild;
    top.textContent = ch;
    if (prev === null) {
      // 首次填充只是把卡片摆好，不做动画
      bot.textContent = ft.textContent = fb.textContent = ch;
      return;
    }
    bot.textContent = prev; // 动画期间下半一直是旧数字
    ft.textContent = prev; // 正面：旧上半
    fb.textContent = ch; // 背面：新下半（扁平 / 立体两档一致）
    clearTimeout(c._flipTimer); // 秒针或秒表连续翻页时别让上一次的落地回调插队
    c.classList.remove("fl");
    void c.offsetWidth; // 不强制回流，同一帧里再挂 .fl 不会重启动画
    c.classList.add("fl");
    const dur = FLIP_MS[st.style] || FLIP_MS.flat;
    c._flipTimer = setTimeout(() => {
      c.classList.remove("fl");
      bot.textContent = ch; // 背面已经盖满，此时换成新数字不会闪
      c._flipTimer = 0;
    }, dur + 30);
  }

  function setSeg(d, ch) {
    if (d._v === ch) return;
    d._v = ch;
    const on = SEG[ch] || "";
    for (const b of d.children)
      b.classList.toggle("on", on.includes(b.dataset.s));
  }

  function fill(node, str, setter, maker) {
    while (node.cells.children.length < str.length)
      node.cells.appendChild(maker());
    while (node.cells.children.length > str.length)
      node.cells.lastChild.remove();
    for (let i = 0; i < str.length; i++) setter(node.cells.children[i], str[i]);
  }

  function readTime() {
    if (st.mode === "stopwatch") {
      const t = Math.floor(
        (st.swRun ? st.swAcc + (performance.now() - st.swStart) : st.swAcc) /
          1000,
      );
      return {
        h: pad(Math.floor(t / 3600) % 24),
        m: pad(Math.floor(t / 60) % 60),
        s: pad(t % 60),
        mer: "",
      };
    }
    if (st.mode === "countdown") {
      let left = st.cdRun
        ? Math.max(0, Math.ceil((st.cdEnd - Date.now()) / 1000))
        : st.cdLeft;
      if (st.cdRun && left === 0) {
        st.cdRun = false;
        st.cdLeft = 0;
        st.cdDone = true;
        setStatus("倒计时到点了（只停住显示，没有动电源）");
      }
      return {
        h: pad(Math.floor(left / 3600)),
        m: pad(Math.floor(left / 60) % 60),
        s: pad(left % 60),
        mer: "",
      };
    }
    const d = new Date();
    let h = d.getHours();
    let mer = "";
    if (st.fmt === "12h") {
      mer = h < 12 ? "AM" : "PM";
      h = h % 12 || 12;
    }
    return {
      h: pad(h),
      m: pad(d.getMinutes()),
      s: pad(d.getSeconds()),
      mer,
    };
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function render() {
    const t = readTime();
    const sTxt = st.sec ? t.s : "";
    for (const [tree, setter, maker] of [
      [flip, setCard, makeCard],
      [led, setSeg, makeSeg],
    ]) {
      fill(tree.h, t.h, setter, maker);
      fill(tree.m, t.m, setter, maker);
      fill(tree.s, sTxt, setter, maker);
      tree.s.grp.hidden = !st.sec;
      tree.s.grp.previousElementSibling.hidden = !st.sec;
    }
    merEl.hidden = !t.mer;
    if (t.mer) merEl.textContent = t.mer;
    // 时钟和跑着的计时器都在走，冒号才闪；停住的状态下别闪
    stage.classList.toggle(
      "still",
      st.mode !== "clock" && !st.swRun && !st.cdRun,
    );
  }

  function applyStyle() {
    stage.dataset.style = st.style;
    stage.style.setProperty("--dur", (FLIP_MS[st.style] || FLIP_MS.flat) + "ms");
    for (const b of styleBtns)
      b.classList.toggle("on", b.dataset.style === st.style);
    // 色轮调的是数码管的发光色，翻页卡没有这个概念，不在的时候别留着占一行
    colorRow.hidden = colorLab.hidden = st.style !== "led";
  }

  function applySize() {
    stage.style.setProperty("--scale", String(st.scale));
    stage.style.setProperty("--bright", String(st.bright));
    scaleIn.value = String(st.scale);
    scaleNum.value = String(st.scale);
    brightIn.value = String(st.bright);
    brightNum.value = String(st.bright);
  }

  function applyFlags() {
    stage.classList.toggle("nobg", !st.bg);
    // 时钟下方的「时 / 分 / 秒」小字：隐藏时连分组的下间距一起收掉，卡片才会居中
    stage.classList.toggle("nolbl", !st.labels);
    for (const b of fmtBtns) b.classList.toggle("on", b.dataset.fmt === st.fmt);
    bgBox.checked = st.bg;
    secBox.checked = st.sec;
    labelsBox.checked = st.labels;
  }

  // 色相=角度（12 点方向是 0，顺时针增大），饱和度=半径
  // 定位用百分比而不是量出来的像素：非数码管风格下这块是 hidden 的，量出来是 0
  function applyColor() {
    stage.style.setProperty("--led-h", String(st.ledH));
    stage.style.setProperty("--led-s", st.ledS + "%");
    const th = (st.ledH * Math.PI) / 180;
    const r = st.ledS / 2;
    knob.style.left = `calc(50% + ${r * Math.sin(th)}%)`;
    knob.style.top = `calc(50% - ${r * Math.cos(th)}%)`;
    colorTxt.textContent = `色相 ${st.ledH} 饱和 ${st.ledS}`;
  }

  function pickColor(e) {
    const b = wheel.getBoundingClientRect();
    const dx = e.clientX - (b.left + b.width / 2);
    const dy = e.clientY - (b.top + b.height / 2);
    st.ledH = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    st.ledS = clampInt(
      Math.min(1, Math.hypot(dx, dy) / (b.width / 2)) * 100,
      0,
      100,
      LED_SAT,
    );
    applyColor();
  }

  wheel.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pickColor(e);
    const move = (ev) => pickColor(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  $("fc-color-reset").addEventListener("click", () => {
    st.ledH = LED_HUE;
    st.ledS = LED_SAT;
    applyColor();
    persist();
  });

  // 浮窗靠 .on 决定显示：收起时是「缩回右下角」而不是突然消失，所以不能用 hidden
  function setPop(open) {
    pop.classList.toggle("on", open);
    gearBtn.setAttribute("aria-expanded", String(open));
    stage.classList.toggle("set-open", open);
  }
  gearBtn.addEventListener("click", () =>
    setPop(!pop.classList.contains("on")),
  );
  // 点齿轮和浮窗以外的任何地方都缩回去
  document.addEventListener("pointerdown", (e) => {
    if (!pop.classList.contains("on")) return;
    const t = e.target;
    if (t instanceof Element && t.closest(".fc-set-wrap")) return;
    setPop(false);
  });

  applyStyle();
  applySize();
  applyFlags();
  applyColor();
  render();
  // 每秒对齐一次：翻页动画正好在秒数跳的那一刻开始。
  // 固定间隔轮询会晚半拍才翻，看着像「数字先跳一下、然后才翻」，不丝滑
  function scheduleRender() {
    const wait = 1000 - (Date.now() % 1000) + 12;
    setTimeout(() => {
      render();
      scheduleRender();
    }, wait);
  }
  scheduleRender();

  for (const b of styleBtns) {
    b.addEventListener("click", () => {
      st.style = b.dataset.style;
      applyStyle();
      persist();
    });
  }
  for (const b of fmtBtns) {
    b.addEventListener("click", () => {
      st.fmt = b.dataset.fmt;
      st.mode = "clock";
      st.cdRun = false;
      st.swRun = false;
      swBtn.textContent = "开始";
      applyFlags();
      setStatus("已切回时钟");
      render();
      persist();
    });
  }

  function bindSize(range, num, key, lo, hi) {
    const set = (v) => {
      st[key] = clampInt(v, lo, hi, st[key]);
      applySize();
    };
    // 数字框只在失去焦点/回车时回写：一边打「140」一边被夹成 40 会打断输入
    range.addEventListener("input", () => set(range.value));
    num.addEventListener("change", () => {
      set(num.value);
      persist();
    });
    range.addEventListener("change", persist);
  }
  bindSize(scaleIn, scaleNum, "scale", 40, 200);
  bindSize(brightIn, brightNum, "bright", 20, 100);

  bgBox.addEventListener("change", () => {
    st.bg = bgBox.checked;
    applyFlags();
    persist();
  });
  secBox.addEventListener("change", () => {
    st.sec = secBox.checked;
    render();
    persist();
  });
  labelsBox.addEventListener("change", () => {
    st.labels = labelsBox.checked;
    applyFlags();
    persist();
  });

  swBtn.addEventListener("click", () => {
    if (st.swRun) {
      st.swAcc += performance.now() - st.swStart;
      st.swRun = false;
      swBtn.textContent = "继续";
      setStatus("正计时已暂停");
    } else {
      st.swStart = performance.now();
      st.swRun = true;
      st.mode = "stopwatch";
      st.cdRun = false;
      swBtn.textContent = "暂停";
      setStatus("正计时中");
    }
    render();
  });
  $("fc-sw-reset").addEventListener("click", () => {
    st.swAcc = 0;
    st.swStart = performance.now();
    st.swRun = false;
    st.mode = "stopwatch";
    st.cdRun = false;
    swBtn.textContent = "开始";
    setStatus("正计时已归零");
    render();
  });

  function startCountdown(sec) {
    if (!sec) {
      setStatus("倒计时是 0，先填个时间");
      return;
    }
    st.mode = "countdown";
    st.cdDone = false;
    st.cdLeft = sec;
    st.cdEnd = Date.now() + sec * 1000;
    st.cdRun = true;
    st.swRun = false;
    swBtn.textContent = "开始";
    setStatus(
      `倒计时开始：${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`,
    );
    render();
  }
  for (const b of $("fc-cd").querySelectorAll("[data-cd]")) {
    b.addEventListener("click", () => startCountdown(Number(b.dataset.cd)));
  }
  $("fc-cd-off").addEventListener("click", () => {
    st.mode = "clock";
    st.cdRun = false;
    st.cdDone = false;
    setStatus("已切回时钟");
    render();
  });
  $("fc-cd-go").addEventListener("click", () => {
    const h = clampInt($("fc-cd-h").value, 0, 23, 0);
    const m = clampInt($("fc-cd-m").value, 0, 59, 0);
    const s = clampInt($("fc-cd-s").value, 0, 59, 0);
    startCountdown(h * 3600 + m * 60 + s);
  });

  function setMax(on) {
    stage.classList.toggle("max", on);
    // 全屏时齿轮和「退出全屏」都收掉（见 styles.css 的 .fc-stage.max），
    // 浮窗要是开着就一起关掉，否则退出全屏会突然弹回来。退出只走 Esc
    if (on) setPop(false);
    // 全屏时把 html 底衬压黑、收掉祖先的浅色边框（见 styles.css 的 html.fc-fullscreen）
    document.documentElement.classList.toggle("fc-fullscreen", on);
    fullBtn.textContent = on ? "退出全屏" : "全屏";
    if (isTauri) {
      try {
        // 覆盖层只铺满客户区，窗口本身还得靠它去顶掉任务栏；失败也不能留未捕获的 promise
        const win = window.__TAURI__.window.getCurrentWindow();
        win.setFullscreen(on).catch((ex) =>
          setStatus(
            "窗口全屏没开成：" + (ex?.message || ex) + "（已按页内铺满显示）",
          ),
        );
        // Windows 的无边框窗口全屏后，系统阴影会在窗口下沿留一条浅色描边；
        // 进全屏关掉、退出还原。老版本没有这个 API 就安静跳过
        if (typeof win.setShadow === "function") {
          win.setShadow(!on).catch(() => {});
        }
      } catch (e) {
        setStatus("窗口全屏调不起来，只做了页内铺满");
      }
    }
  }
  fullBtn.addEventListener("click", () =>
    setMax(!stage.classList.contains("max")),
  );
  // Esc 一层层退：先收浮窗，浮窗没开才退出全屏
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (pop.classList.contains("on")) {
      e.stopPropagation();
      setPop(false);
      return;
    }
    if (!stage.classList.contains("max")) return;
    e.stopPropagation();
    setMax(false);
  });
  // 从别的页签切回来时，全屏覆盖层和浮窗都不能留在屏幕上盖住别人
  new MutationObserver(() => {
    if (!pageEl.classList.contains("hidden")) return;
    setPop(false);
    if (stage.classList.contains("max")) setMax(false);
  }).observe(pageEl, { attributes: true, attributeFilter: ["class"] });
}
