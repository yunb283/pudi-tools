// 打包前自动递增版本号，并把所有地方都改成同一个值：
//   package.json、package-lock.json、src-tauri/tauri.conf.json、
//   src-tauri/Cargo.toml、src-tauri/Cargo.lock
//
// 用法：
//   node scripts/bump-version.mjs              递增修订号   0.1.2 -> 0.1.3
//   node scripts/bump-version.mjs minor        递增次版本号 0.1.2 -> 0.2.0
//   node scripts/bump-version.mjs major        递增主版本号 0.1.2 -> 1.0.0
//   node scripts/bump-version.mjs --set 1.2.3  直接设成某个版本号
//   node scripts/bump-version.mjs --dry-run    只显示要改成什么，不落盘
//
// 只改「版本号那一行」，整个文件重新排版的事不干，免得把别人的改动冲掉。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const setIdx = argv.indexOf('--set');
const levelArg = argv.find((a) => !a.startsWith('--') && a !== 'minor' && a !== 'major' && a !== 'patch');

let current = '';
try {
  current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '';
} catch (e) {
  console.error('读 package.json 失败：' + e.message);
  process.exit(1);
}

let next = '';
if (setIdx >= 0) {
  next = argv[setIdx + 1] || '';
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error('版本号格式不对（要 x.y.z）：' + next);
    process.exit(1);
  }
} else {
  const level = levelArg || 'patch';
  if (!['patch', 'minor', 'major'].includes(level)) {
    console.error('未知的递增方式：' + level + '（可用 patch / minor / major）');
    process.exit(1);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) {
    console.error('版本号格式不对（要 x.y.z）：' + current);
    process.exit(1);
  }
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  next = `${major}.${minor}.${patch}`;
}

if (next === current) {
  console.log(`版本号已经是 ${current}，没动。`);
  process.exit(0);
}

// 每个文件给一条精确的规则：只认「版本号字段」本身，不看它当前是多少。
// 这样即使某个文件里的版本号被手动改乱了，这次也会被拉回同一个值。
const targets = [
  {
    file: 'package.json',
    re: /("version"\s*:\s*")[^"]*(")/,
    label: 'version 字段',
  },
  {
    file: 'package-lock.json',
    re: /("name"\s*:\s*"tauri-app",\s*"version"\s*:\s*")[^"]*(")/,
    label: 'tauri-app 的 version',
  },
  {
    file: path.join('src-tauri', 'tauri.conf.json'),
    re: /("version"\s*:\s*")[^"]*(")/,
    label: 'version 字段',
  },
  {
    file: path.join('src-tauri', 'Cargo.toml'),
    re: /(version\s*=\s*")[^"]*(")/,
    label: 'version 字段',
  },
  {
    file: path.join('src-tauri', 'Cargo.lock'),
    re: /(name\s*=\s*"tauri-app"\s*\nversion\s*=\s*")[^"]*(")/,
    label: 'tauri-app 的 version',
  },
];

const changed = [];
for (const t of targets) {
  const p = path.join(root, t.file);
  if (!fs.existsSync(p)) continue;
  const txt = fs.readFileSync(p, 'utf8');
  const m = t.re.exec(txt);
  if (!m) {
    console.warn(`  跳过 ${t.file}：里面没找到${t.label}`);
    continue;
  }
  if (m[1] + next + m[2] === m[0]) continue; // 已经是这个值了
  changed.push(t.file);
  if (dry) continue;
  fs.writeFileSync(p, txt.replace(t.re, `$1${next}$2`), 'utf8');
}

console.log(`版本号 ${current} -> ${next}`);
if (changed.length) {
  console.log('  已同步：' + changed.join('、'));
} else {
  console.log('  没有可改的文件');
}
if (dry) console.log('  （--dry-run，没有真的写盘）');
