// 打包前的准备，两步：
//   1) 版本号自动 +1（package.json / tauri.conf.json / Cargo.toml / lock 一起改）
//   2) 把 ffmpeg.exe、yt-dlp.exe 这些外部依赖准备好
//
// tauri.conf.json 的 beforeBuildCommand 只认一条命令，所以两步放这个脚本里串着跑。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function run(cmd, args, label) {
  console.log(`[prepare] ${label}…`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error(`[prepare] ${label} 失败：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[prepare] ${label} 失败（退出码 ${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

// 1) 版本号 +1
run(process.execPath, [path.join(root, 'scripts', 'bump-version.mjs')], '递增版本号');

// 2) 外部依赖
const deps = path.join(root, 'scripts', 'download-deps.ps1');
if (fs.existsSync(deps)) {
  const ps = process.platform === 'win32' ? 'powershell' : 'pwsh';
  run(ps, ['-ExecutionPolicy', 'Bypass', '-File', deps], '准备 ffmpeg / yt-dlp');
}
