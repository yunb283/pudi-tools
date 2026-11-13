// 改名规则引擎：纯函数。输入 (条目, 可见行号, 规则) 输出新文件名 + 状态。
// 任一规则控件变化都会触发一次全量计算，列表实时反映结果。
// 移植自 RenameBox（MIT），仅做了与本项目无关的极小整理。

const ILLEGAL = /[<>:"/\\|?*]/;

export function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i + 1) };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 文本转换 ----------

// 简繁对照（文件名常用字，成对追加即可扩充）
const SIMP_TRAD = [
  ['云', '雲'], ['万', '萬'], ['与', '與'], ['丑', '醜'], ['专', '專'], ['业', '業'],
  ['丛', '叢'], ['东', '東'], ['丝', '絲'], ['两', '兩'], ['严', '嚴'], ['个', '個'],
  ['丰', '豐'], ['陆', '陸'], ['陈', '陳'], ['险', '險'], ['隐', '隱'], ['电', '電'],
  ['书', '書'], ['买', '買'], ['号', '號'], ['线', '線'], ['级', '級'], ['纸', '紙'],
  ['纹', '紋'], ['细', '細'], ['织', '織'], ['终', '終'], ['经', '經'], ['结', '結'],
  ['给', '給'], ['络', '絡'], ['统', '統'], ['继', '繼'], ['绩', '績'], ['维', '維'],
  ['综', '綜'], ['缓', '緩'], ['编', '編'], ['缩', '縮'], ['网', '網'], ['罗', '羅'],
  ['笔', '筆'], ['简', '簡'], ['节', '節'], ['术', '術'], ['机', '機'], ['权', '權'],
  ['财', '財'], ['货', '貨'], ['资', '資'], ['员', '員'], ['则', '則'], ['规', '規'],
  ['视', '視'], ['证', '證'], ['评', '評'], ['识', '識'], ['译', '譯'], ['试', '試'],
  ['话', '話'], ['询', '詢'], ['该', '該'], ['详', '詳'], ['语', '語'], ['说', '說'],
  ['请', '請'], ['诸', '諸'], ['读', '讀'], ['调', '調'], ['谈', '談'], ['护', '護'],
  ['报', '報'], ['担', '擔'], ['拟', '擬'], ['拥', '擁'], ['挂', '掛'], ['数', '數'],
  ['断', '斷'], ['无', '無'], ['显', '顯'], ['晓', '曉'], ['旧', '舊'], ['时', '時'],
  ['见', '見'], ['观', '觀'], ['记', '記'], ['讲', '講'], ['许', '許'], ['论', '論'],
  ['设', '設'], ['检', '檢'], ['楼', '樓'], ['标', '標'], ['栏', '欄'], ['树', '樹'],
  ['样', '樣'], ['档', '檔'], ['梦', '夢'], ['欢', '歡'], ['岁', '歲'], ['历', '歷'],
  ['归', '歸'], ['当', '當'], ['录', '錄'], ['备', '備'], ['处', '處'], ['复', '復'],
  ['头', '頭'], ['夹', '夾'], ['夺', '奪'], ['夸', '誇'], ['运', '運'], ['还', '還'],
  ['这', '這'], ['进', '進'], ['远', '遠'], ['连', '連'], ['迟', '遲'], ['迹', '跡'],
  ['选', '選'], ['赵', '趙'], ['过', '過'], ['马', '馬'], ['驶', '駛'], ['驱', '驅'],
  ['驳', '駁'], ['驻', '駐'], ['驾', '駕'], ['骑', '騎'], ['验', '驗'], ['骤', '驟'],
  ['鱼', '魚'], ['鲜', '鮮'], ['鸟', '鳥'], ['鸡', '雞'], ['麦', '麥'], ['黄', '黃'],
  ['齐', '齊'], ['齿', '齒'], ['龙', '龍'], ['图', '圖'], ['片', '片'], ['文', '文'],
];

const S2T = new Map(SIMP_TRAD);
const T2S = new Map(SIMP_TRAD.map(([a, b]) => [b, a]));

// 拼音首字母：ICU 的 zh-CN 排序即拼音序，取每个声母组的首字作边界做二分。
// 23 个边界字对 160 个常用字实测全对；多音字按 ICU 收录的读音走。
const PY_MARKERS = ['啊', '八', '擦', '搭', '蛾', '发', '噶', '哈', '击', '喀', '垃', '妈', '拿', '哦', '啪', '七', '然', '撒', '他', '挖', '吸', '压', '匝'];
const PY_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z'];
const pyCollator = new Intl.Collator('zh-CN-u-co-pinyin');

function pinyinInitial(ch) {
  let lo = 0, hi = PY_MARKERS.length - 1, res = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (pyCollator.compare(ch, PY_MARKERS[m]) >= 0) {
      res = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return PY_LETTERS[res];
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UNITS = ['', '十', '百', '千'];

function numToCn(n) {
  if (n <= 0) return '零';
  if (n >= 10000) return String(n);
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = +s[i];
    const u = s.length - 1 - i;
    if (d === 0) {
      if (out && !out.endsWith('零')) out += '零';
    } else {
      // 「十」在词首省略「一」
      out += (d === 1 && u === 1 && out === '' ? '' : CN_DIGITS[d]) + CN_UNITS[u];
    }
  }
  return out.replace(/零$/, '');
}

function cnToNum(s) {
  const dig = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
  const uni = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in dig) cur = dig[ch];
    else if (ch in uni) {
      total += (cur || (uni[ch] === 10 ? 1 : 0)) * uni[ch];
      cur = 0;
    } else return null;
  }
  return total + cur;
}

export function convertText(name, mode) {
  switch (mode) {
    case 's2t':
      return [...name].map((c) => S2T.get(c) || c).join('');
    case 't2s':
      return [...name].map((c) => T2S.get(c) || c).join('');
    case 'n2cn':
      return name.replace(/\d+/g, (m) => numToCn(parseInt(m, 10)));
    case 'cn2n':
      return name.replace(/[零一二三四五六七八九十百千两]+/g, (m) => {
        const v = cnToNum(m);
        return v === null ? m : String(v);
      });
    case 'pinyin':
      return [...name].map((c) => (/[一-鿿]/.test(c) ? pinyinInitial(c) : c)).join('');
    default:
      return name;
  }
}

// ---------- 序号 ----------

export function formatSeq(index, rule) {
  const n = rule.start + index * rule.step;
  let s = String(n);
  const pad = Math.max(0, rule.digits - s.length);
  if (rule.padChar === 'space') return ' '.repeat(pad) + s;
  if (rule.padChar === 'none') return s;
  return '0'.repeat(pad) + s;
}

// 前导零补位：digits 为 0 时不补位，填 3 得到 001 / 002
export function padNumber(n, digits) {
  const s = String(n);
  const pad = Math.max(0, (digits || 0) - s.length);
  return pad ? '0'.repeat(pad) + s : s;
}

// ---------- 主流程 ----------

// entry: { name, parentName }；index: 过滤后的可见行号
// 返回 { newName, status }，status: ok | same | illegal | empty
export function computeNewName(entry, index, rules) {
  const { ext: rawExt, ..._ } = splitName(entry.name);
  let base = splitName(entry.name).base;
  let ext = rawExt;
  let pre = '';
  let suf = '';
  const warnings = [];

  // 1. 替换
  const rp = rules.replace;
  if (rp.enabled && rp.find) {
    try {
      const re = new RegExp(rp.useRegex ? rp.find : escapeRe(rp.find), 'g' + (rp.caseSensitive ? '' : 'i'));
      const to = rp.useRegex ? rp.to : rp.to.replaceAll('$', '$$');
      if (rp.target !== 'ext') base = base.replace(re, to);
      if (rp.target !== 'name') ext = ext.replace(re, to);
    } catch (e) {
      warnings.push('替换正则非法');
    }
  }

  if (warnings.length) return { newName: entry.name, status: 'illegal', warnings };

  // 2. 删除
  const rm = rules.remove;
  if (rm.enabled) {
    if (rm.mode === 'content' && rm.content) {
      try {
        const re = new RegExp(rm.useRegex ? rm.content : escapeRe(rm.content), 'g' + (rm.caseSensitive ? '' : 'i'));
        base = base.replace(re, '');
        ext = ext.replace(re, '');
      } catch {
        warnings.push('删除正则非法');
      }
    } else if (rm.mode === 'position') {
      const from = Math.max(1, rm.posFrom) - 1;
      const to = rm.posTo > 0 ? rm.posTo : base.length;
      base = base.slice(0, from) + base.slice(to);
    }
  }

  if (warnings.length) return { newName: entry.name, status: 'illegal', warnings };

  // 3. 序号（先算出来，模板和名称插入都用它）
  const sq = rules.seq;
  let seq = '';
  if (sq.enabled) {
    seq = formatSeq(index, sq);
    if (sq.position !== 'template') {
      // 分隔符始终贴在序号靠名称的一侧
      if (sq.position === 'before') base = seq + (sq.sep || '') + base;
      else base = base + (sq.sep || '') + seq;
    }
  }

  // 4. 模板：整名结构，{name} 用前面各步处理过的名称
  const tp = rules.template;
  if (tp.enabled && tp.text) {
    const md = entry.mtime ? new Date(entry.mtime * 1000) : null;
    const d = md || new Date();
    const pad2 = (x) => String(x).padStart(2, '0');
    const sizeKB = entry.size != null ? (entry.size / 1024).toFixed(entry.size < 1024 ? 0 : 1) : '0';
    const ctx = {
      name: base,
      ext,
      num: seq,
      index: String(index + 1),
      date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
      mtime: String(entry.mtime || 0),
      parent: entry.parentName || '',
      size: String(entry.size || 0),
      sizeKB,
      rand: String(entry.random6 ?? Math.floor(Math.random() * 900000) + 100000),
    };
    const filled = tp.text.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
    const sp = splitName(filled);
    base = sp.base;
    if (sp.ext) ext = sp.ext;
  }

  // 5. 添加前后缀
  const ad = rules.add;
  if (ad.enabled) {
    if (ad.target === 'full') {
      pre = ad.prefix || '';
      suf = ad.suffix || '';
    } else {
      base = (ad.prefix || '') + base + (ad.suffix || '');
    }
  }

  // 6. 整体：大小写 / 随机数 / 递增数
  const o = rules.overall;
  if (o.nameMode === 'upper') base = base.toUpperCase();
  else if (o.nameMode === 'lower') base = base.toLowerCase();
  else if (o.nameMode === 'title') base = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  else if (o.nameMode === 'random') base = String(entry.random7 ?? Math.floor(Math.random() * 9000000) + 1000000);
  else if (o.nameMode === 'increase') base = padNumber(o.incStart + index, o.incDigits);
  else if (o.nameMode === 'prefixNum') base = (o.numPrefix || '') + padNumber(o.numStart + index, o.numDigits);

  // 7. 文本转换
  if (o.convert !== 'none') base = convertText(base, o.convert);

  // 8. 扩展名
  if (o.extMode === 'del') ext = '';
  else if (o.extMode === 'to') ext = (o.extTo || '').replace(/^\./, '');
  else if (o.extMode === 'upper') ext = ext.toUpperCase();
  else if (o.extMode === 'lower') ext = ext.toLowerCase();

  const joined = pre + base + (ext ? '.' + ext : '') + suf;
  const newName = joined.replace(/[<>:"/\\|?*]/g, '').trim();

  // 名称主干被删空时不产出 ".png" 这类退化名，整行按无效处理
  if (!base.trim() && !pre && !suf) return { newName: entry.name, status: 'empty', warnings };
  if (!newName) return { newName: entry.name, status: 'empty', warnings };
  if (ILLEGAL.test(joined)) warnings.push('含非法字符，已自动剔除');
  if (/[. ]$/.test(newName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(newName) || /[\x00-\x1f]/.test(newName)) {
    warnings.push('Windows 不支持此文件名');
    return { newName, status: 'illegal', warnings };
  }
  if (newName === entry.name) return { newName, status: 'same', warnings };
  return { newName, status: 'ok', warnings };
}

// 过滤：关键字 + 扩展名白名单，两者都空则全通过
export function passesFilter(entry, filter) {
  const kw = (filter.keyword || '').trim().toLowerCase();
  if (kw && !entry.name.toLowerCase().includes(kw)) return false;
  const list = (filter.exts || '').trim().toLowerCase().replace(/^\./, '');
  if (list) {
    const allow = list.split(/[,，\s]+/).filter(Boolean);
    const ext = splitName(entry.name).ext.toLowerCase();
    if (!allow.includes(ext)) return false;
  }
  return true;
}
