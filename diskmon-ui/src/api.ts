import { normalizeWinPath } from './format';
import type {
  ComparePayload, DiffRow, FolderRankRow, OverviewPayload, Progress, ScanError,
  ScheduleInfo, Settings, SnapshotRow, TrendPoint, VolumeInfo,
} from './types';

type Args = Record<string, unknown>;

interface TauriGlobal {
  core?: { invoke: (cmd: string, args?: Args) => Promise<unknown> };
  event?: { listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> };
}

function tauri(): TauriGlobal | undefined {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

export const isDesktop = (): boolean => !!tauri()?.core;

const DENIED_IN_BROWSER = new Set([
  'dm_start_scan', 'dm_cancel_scan', 'dm_delete_snapshots', 'dm_prune',
  'dm_set_settings', 'dm_set_schedule', 'dm_remove_schedule', 'dm_reveal',
]);

export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  // 定位命令统一在这里归一化路径：C:/…、c:\…、\\?\C:\… 等写法都应可用，
  // 越界/空路径在本地就给出带上下文的说明，不必绕到 Rust 再弹一条无上下文的错误。
  if (cmd === 'dm_reveal') {
    const raw = args?.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('定位失败：没有可定位的路径');
    }
    const win = normalizeWinPath(raw);
    if (!win) {
      throw new Error(`无法定位「${raw}」：本工具只扫描 C 盘，只能定位 C 盘内的路径`);
    }
    args = { ...args, path: win };
  }
  const t = tauri();
  if (!t?.core) {
    if (DENIED_IN_BROWSER.has(cmd)) {
      throw new Error('浏览器预览模式不执行任何磁盘操作，请在桌面端运行');
    }
    await new Promise((r) => setTimeout(r, 60)); // 让加载态可见，贴近真实调用
    return mock(cmd, args) as T;
  }
  return (await t.core.invoke(cmd, args)) as T;
}

export async function listenProgress(
  cb: (p: Progress) => void,
  onFinished?: (info: { ok: boolean; status?: string }) => void,
): Promise<() => void> {
  const t = tauri();
  if (!t?.event) return () => {};
  const un1 = await t.event.listen('diskmon://progress', (e) => cb(e.payload as Progress));
  try {
    const un2 = await t.event.listen('diskmon://finished', (e) =>
      onFinished?.(e.payload as { ok: boolean; status?: string }),
    );
    return () => { un1(); un2(); };
  } catch (e) {
    un1();
    throw e;
  }
}

// ─────────────────────── 浏览器预览演示数据（界面顶部会明确标注） ───────────────────────

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86400;
const BASE = Math.floor(Date.now() / 1000);

function mkRow(path: string, a: number, b: number, isDir: boolean, context = false): DiffRow {
  const parts = path.replace(/^C:\\/, '').split('\\').filter(Boolean);
  const parent = parts.length === 0
    ? null
    : 'C:\\' + (parts.length > 1 ? parts.slice(0, -1).join('\\') : '');
  const delta = b - a;
  let kind: DiffRow['kind'] = 'same';
  if (a === 0 && b > 0) kind = 'added';
  else if (b === 0 && a > 0) kind = 'removed';
  else if (delta > 0) kind = 'grown';
  else if (delta < 0) kind = 'shrunk';
  return {
    path, parent,
    name: parts.length ? parts[parts.length - 1] : 'C:\\',
    is_dir: isDir,
    depth: parts.length,
    size_a: a, size_b: b, delta,
    pct: a > 0 ? (delta / a) * 100 : null,
    kind,
    ext: isDir ? null : (parts[parts.length - 1]?.split('.').pop() ?? null),
    context,
  };
}

const SNAP: SnapshotRow[] = Array.from({ length: 12 }, (_, i) => {
  const id = 12 - i;
  const status = id === 12 ? 'partial' : id === 10 ? 'cancelled' : 'complete';
  return {
    id,
    started_at: BASE - i * DAY - 3 * 3600,
    finished_at: status === 'cancelled' ? null : BASE - i * DAY - 3 * 3600 + 740,
    root_path: 'C:\\',
    status,
    total_bytes: Math.round((428 + (12 - id) * 0.42) * GB),
    file_count: 812_400 + (12 - id) * 2_940,
    dir_count: 96_310 + (12 - id) * 180,
    error_count: status === 'partial' ? 37 : status === 'cancelled' ? 0 : 12,
    reparse_count: 1_284,
    volume_total: Math.round(475.6 * GB),
    volume_free: Math.round((40.3 - (12 - id) * 0.3) * GB),
  };
});

const RANKING: DiffRow[] = [
  mkRow('C:\\Users\\25351\\AppData\\Local\\Temp', 1.4 * GB, 3.2 * GB, true),
  mkRow('C:\\Users\\25351\\Downloads', 18.2 * GB, 19.1 * GB, true),
  mkRow('C:\\Windows\\Installer', 6.1 * GB, 6.42 * GB, true),
  mkRow('C:\\Users\\25351\\Downloads\\pudi-tools\\node_modules', 0, 0.31 * GB, true),
  mkRow('C:\\pagefile.sys', 12 * GB, 12.24 * GB, false),
  mkRow('C:\\Windows\\SoftwareDistribution\\Download', 2.4 * GB, 2.58 * GB, true),
  mkRow('C:\\Users\\25351\\AppData\\Local\\Microsoft\\Edge\\Cache', 0.9 * GB, 1.05 * GB, true),
  mkRow('C:\\Users\\25351\\Desktop\\old-backup.zip', 2.2 * GB, 0, false),
];

function mkFolder(path: string, sizeGB: number): FolderRankRow {
  const parts = path.replace(/^C:\\/, '').split('\\').filter(Boolean);
  return {
    path,
    name: parts[parts.length - 1] ?? path,
    size_bytes: Math.round(sizeGB * GB),
    depth: parts.length,
  };
}

// 首页「文件夹占用空间排行」演示数据：按递归汇总体积降序，父目录必然不小于子目录。
const FOLDERS: FolderRankRow[] = [
  mkFolder('C:\\Users', 97.9),
  mkFolder('C:\\Users\\25351', 89.9),
  mkFolder('C:\\Users\\25351\\AppData', 43.8),
  mkFolder('C:\\Users\\25351\\AppData\\Local', 39.8),
  mkFolder('C:\\Windows', 32.2),
  mkFolder('C:\\Program Files', 24.0),
  mkFolder('C:\\Users\\25351\\Downloads', 19.1),
  mkFolder('C:\\ProgramData', 12.6),
  mkFolder('C:\\Windows\\Installer', 6.42),
  mkFolder('C:\\Windows\\WinSxS', 5.8),
  mkFolder('C:\\Windows\\SoftwareDistribution', 3.28),
  mkFolder('C:\\Users\\25351\\AppData\\Local\\Temp', 3.2),
];

const TREE: DiffRow[] = [
  mkRow('C:\\', 428 * GB, 430.4 * GB, true, true),
  mkRow('C:\\Users', 96 * GB, 97.9 * GB, true, true),
  mkRow('C:\\Users\\25351', 88 * GB, 89.9 * GB, true, true),
  mkRow('C:\\Users\\25351\\AppData', 42 * GB, 43.8 * GB, true),
  mkRow('C:\\Users\\25351\\AppData\\Local', 38 * GB, 39.8 * GB, true, true),
  mkRow('C:\\Users\\25351\\AppData\\Local\\Temp', 1.4 * GB, 3.2 * GB, true),
  mkRow('C:\\Users\\25351\\AppData\\Local\\Temp\\cache_7f3a.dat', 0, 1.2 * GB, false),
  mkRow('C:\\Users\\25351\\AppData\\Local\\Temp\\msdt.tmp', 0.6 * GB, 0.2 * GB, false),
  mkRow('C:\\Users\\25351\\Downloads', 18.2 * GB, 19.1 * GB, true),
  mkRow('C:\\Users\\25351\\Downloads\\pudi-tools', 0.42 * GB, 0.73 * GB, true, true),
  mkRow('C:\\Users\\25351\\Downloads\\pudi-tools\\node_modules', 0, 0.31 * GB, true),
  mkRow('C:\\Users\\25351\\Desktop', 2.2 * GB, 0, true, true),
  mkRow('C:\\Windows', 32 * GB, 32.2 * GB, true, true),
  mkRow('C:\\Windows\\Installer', 6.1 * GB, 6.42 * GB, true),
  mkRow('C:\\Windows\\SoftwareDistribution', 3.1 * GB, 3.28 * GB, true, true),
  mkRow('C:\\pagefile.sys', 12 * GB, 12.24 * GB, false),
  mkRow('C:\\hiberfil.sys', 6.4 * GB, 6.4 * GB, false),
  mkRow('C:\\Users\\25351\\Desktop\\old-backup.zip', 2.2 * GB, 0, false),
];

const CHILDREN: Record<string, DiffRow[]> = {
  'C:\\': [
    mkRow('C:\\Users', 96 * GB, 97.9 * GB, true, true),
    mkRow('C:\\Windows', 32 * GB, 32.2 * GB, true, true),
    mkRow('C:\\Program Files', 24 * GB, 24 * GB, true, true),
    mkRow('C:\\pagefile.sys', 12 * GB, 12.24 * GB, false),
    mkRow('C:\\hiberfil.sys', 6.4 * GB, 6.4 * GB, false),
  ],
  'C:\\Users\\25351\\AppData\\Local\\Temp': [
    mkRow('C:\\Users\\25351\\AppData\\Local\\Temp\\cache_7f3a.dat', 0, 1.2 * GB, false),
    mkRow('C:\\Users\\25351\\AppData\\Local\\Temp\\msdt.tmp', 0.6 * GB, 0.2 * GB, false),
    mkRow('C:\\Users\\25351\\AppData\\Local\\Temp\\setup.log', 2 * MB, 2 * MB, false),
  ],
  'C:\\Users\\25351\\Downloads': [
    mkRow('C:\\Users\\25351\\Downloads\\pudi-tools', 0.42 * GB, 0.73 * GB, true, true),
    mkRow('C:\\Users\\25351\\Downloads\\old-backup.zip', 2.2 * GB, 0, false),
  ],
  'C:\\Windows\\Installer': [
    mkRow('C:\\Windows\\Installer\\{a1b2}.msi', 0.18 * GB, 0.5 * GB, false),
    mkRow('C:\\Windows\\Installer\\{c3d4}.msp', 0.32 * GB, 0.32 * GB, false),
  ],
};

const ERRORS: ScanError[] = [
  { path: 'C:\\Windows\\System32\\config\\SAM', kind: 'permission', message: '拒绝访问 (os error 5)' },
  { path: 'C:\\System Volume Information', kind: 'permission', message: '拒绝访问 (os error 5)' },
  { path: 'C:\\$Recycle.Bin\\S-1-5-18', kind: 'permission', message: '拒绝访问 (os error 5)' },
  { path: 'C:\\Users\\25351\\AppData\\Local\\Temp\\tmp9F2.tmp', kind: 'disappeared', message: '文件在扫描期间被删除' },
  { path: 'C:\\ProgramData\\Microsoft\\Windows\\Containers', kind: 'io', message: '目录不可读' },
];

const TREND: TrendPoint[] = SNAP.filter((s) => s.status !== 'cancelled').slice(0, 7).reverse().map((s) => ({
  id: s.id, started_at: s.started_at, total_bytes: s.total_bytes,
  status: s.status, file_count: s.file_count,
}));

const SETTINGS: Settings = {
  max_snapshots: 30, auto_prune: true,
  follow_reparse: false, read_content: false, root_path: 'C:\\',
};

const SCHEDULE: ScheduleInfo = {
  enabled: false, frequency: 'daily', time_hhmm: '09:00', weekday: 1,
  task_name: 'PudiTools DiskMonitor C', registered: false, detail: '未注册',
};

const VOLUME: VolumeInfo = {
  total: Math.round(475.6 * GB),
  free: Math.round(40.3 * GB),
  used: Math.round(435.3 * GB),
};

const IDLE: Progress = {
  running: false, snapshot_id: null, files: 0, dirs: 0, bytes: 0, errors: 0,
  reparse: 0, current_path: 'C:\\', started_at: 0, percent: 0, phase: 'idle',
  message: '尚未开始扫描',
};

function mock(cmd: string, args?: Args): unknown {
  switch (cmd) {
    case 'dm_scan_progress': return IDLE;
    case 'dm_schedule': return SCHEDULE;
    case 'dm_snapshot_errors': return ERRORS;
    case 'dm_overview':
      return {
        db_path: '%APPDATA%\\com.spritetools.seqtool\\diskmon.sqlite3', settings: SETTINGS,
        volume: VOLUME, latest: SNAP[0], snapshot_count: SNAP.length, snapshots: SNAP,
        net_delta: Math.round(2.4 * GB), trend: TREND, pair: [11, 12],
        rankings: {
          growth: RANKING,
          pct: [...RANKING].sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity)),
          size: [...RANKING].sort((a, b) => b.size_b - a.size_b),
        },
        reliable: false, status_a: 'complete', status_b: 'partial',
        has_pair: true,
        folders: FOLDERS, folder_snapshot_id: SNAP[0].id,
        folder_status: SNAP[0].status, folder_total_bytes: SNAP[0].total_bytes,
      } satisfies OverviewPayload;
    case 'dm_compare':
      return {
        rows: TREE, total_changed: 214_880,
        truncated: true, truncated_count: 214_580,
        // 默认 B = 最新快照 #12（不完整），此时必须判定为不可靠并显示警示条
        reliable: (args?.b ?? 12) !== 12,
        status_a: 'complete', status_b: (args?.b ?? 12) === 12 ? 'partial' : 'complete',
        error_count_a: 12, error_count_b: 37,
      } satisfies ComparePayload;
    case 'dm_compare_children':
      return CHILDREN[String(args?.parent)] ?? [];
    case 'dm_delete_snapshots': case 'dm_prune': return 0;
    case 'dm_set_settings': return { ...SETTINGS, ...(args ?? {}) };
    case 'dm_start_scan': case 'dm_cancel_scan': return IDLE;
    default: return null;
  }
}
