// 从设计稿抽取 dm-* 组件样式，作用域化到 #page-diskmon。
// 设计稿调整后执行 `npm run gen:style` 重新生成 src/style.css。
// 主题变量沿用主程序 src/styles.css，本文件只带 --dm-* 状态色。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(root, 'design/disk-monitor-design.html'), 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];

function varsOf(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}');
  const m = style.match(re);
  if (!m) return '';
  return m[1]
    .split('\n')
    .filter((l) => /^\s*--dm-[\w-]+\s*:/.test(l))
    .map((l) => '  ' + l.trim())
    .join('\n');
}

const marker = '/* ---------- 页面骨架';
const start = style.indexOf(marker);
if (start < 0) throw new Error('找不到页面骨架样式段');
const body = style.slice(start);

function transform(css) {
  let out = '';
  let i = 0;
  const len = css.length;
  while (i < len) {
    if (css.startsWith('/*', i)) {
      const j = css.indexOf('*/', i) + 2;
      out += css.slice(i, j).trim() + '\n';
      i = j;
      continue;
    }
    if (/\s/.test(css[i])) { i++; continue; }
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const selector = css.slice(i, brace).trim();
    let depth = 1;
    let k = brace + 1;
    while (k < len && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const inner = css.slice(brace + 1, k - 1);
    if (selector.startsWith('@media')) {
      out += selector + ' {\n' + transform(inner) + '}\n';
    } else if (selector.startsWith('@')) {
      out += selector + ' {' + inner + '}\n';
    } else if (/^(\.page|\*|html, body|body|\[hidden\]|::)/.test(selector)) {
      // 全局规则由主 styles.css 提供
    } else {
      const scoped = selector.split(',').map((s) => {
        s = s.trim();
        if (s.startsWith('html.light')) return 'html.light #page-diskmon ' + s.slice(10).trim();
        if (s.startsWith('html ')) return 'html #page-diskmon ' + s.slice(4).trim();
        return '#page-diskmon ' + s;
      }).join(', ');
      out += scoped + ' {' + inner + '}\n';
    }
    i = k;
  }
  return out;
}

const out = `/* 磁盘空间变化监测（仅 C 盘）—— 由 design/disk-monitor-design.html 抽取生成。
   主题变量沿用 src/styles.css；本文件只定义 --dm-* 状态色，并把所有组件样式
   作用域化到 #page-diskmon，确保与软件其它页签互不干扰。
   重新生成：npm --prefix diskmon-ui run gen:style */
:root {
${varsOf(':root')}
}
html.light {
${varsOf('html.light')}
}
#page-diskmon > #diskmon-root {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
}
#page-diskmon .dm-shell { flex: 1; min-height: 0; }
#page-diskmon .dm-views { padding-bottom: 16px; }
/* 数值列不换行，避免 "+1.80 GB" 被折成两行 */
#page-diskmon .dm-table th.num, #page-diskmon .dm-table td.num { white-space: nowrap; }
/* 首页排行榜放在窄栏里，路径列收紧以留出状态徽标 */
#page-diskmon .dm-table.rank-table .path { max-width: 190px; }
#page-diskmon .dm-table.rank-table th, #page-diskmon .dm-table.rank-table td { padding: 6px 7px; }
${transform(body)}`;

fs.writeFileSync(path.join(root, 'diskmon-ui/src/style.css'), out, 'utf8');
console.log('generated diskmon-ui/src/style.css:', out.split('\n').length, 'lines');
