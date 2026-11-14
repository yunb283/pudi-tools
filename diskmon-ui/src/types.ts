// 与 src-tauri/src/diskmon/ 的 serde 结构一一对应（字段名保持 snake_case）。

export interface Progress {
  running: boolean;
  snapshot_id: number | null;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  reparse: number;
  current_path: string;
  started_at: number;
  percent: number;
  phase: string;
  message: string;
}

export interface VolumeInfo {
  total: number;
  free: number;
  used: number;
}

export interface Settings {
  max_snapshots: number;
  auto_prune: boolean;
  follow_reparse: boolean;
  read_content: boolean;
  root_path: string;
}

export interface ScheduleInfo {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | string;
  time_hhmm: string;
  weekday: number;
  task_name: string;
  registered: boolean;
  detail: string;
}

export interface SnapshotRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  root_path: string;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | string;
  total_bytes: number;
  file_count: number;
  dir_count: number;
  error_count: number;
  reparse_count: number;
  volume_total: number;
  volume_free: number;
}

export interface ScanError {
  path: string;
  kind: string;
  message: string;
}

export type ChangeKind = 'added' | 'removed' | 'grown' | 'shrunk' | 'same';

export interface DiffRow {
  path: string;
  parent: string | null;
  name: string;
  is_dir: boolean;
  depth: number;
  size_a: number;
  size_b: number;
  delta: number;
  pct: number | null;
  kind: ChangeKind;
  ext: string | null;
  context: boolean;
}

export interface ComparePayload {
  rows: DiffRow[];
  total_changed: number;
  truncated: boolean;
  truncated_count: number;
  reliable: boolean;
  status_a: string;
  status_b: string;
  error_count_a: number;
  error_count_b: number;
}

export interface TrendPoint {
  id: number;
  started_at: number;
  total_bytes: number;
  status: string;
  file_count: number;
}

/** 首页「文件夹占用空间排行」一行：size_bytes 为含所有子目录的递归汇总大小。 */
export interface FolderRankRow {
  path: string;
  name: string;
  size_bytes: number;
  depth: number;
}

export type OverviewRankings = Record<SortKey, DiffRow[]>;

export interface OverviewPayload {
  db_path: string;
  settings: Settings;
  volume: VolumeInfo;
  snapshots: SnapshotRow[];
  latest: SnapshotRow | null;
  snapshot_count: number;
  net_delta: number;
  trend: TrendPoint[];
  pair: [number, number] | null;
  rankings: OverviewRankings | null;
  reliable: boolean;
  status_a: string;
  status_b: string;
  has_pair: boolean;
  folders: FolderRankRow[];
  folder_snapshot_id: number | null;
  folder_status: string;
  folder_total_bytes: number;
}

export type ViewKey = 'overview' | 'trend' | 'scan' | 'snapshots' | 'compare' | 'settings';
export type SortKey = 'growth' | 'pct' | 'size';
export type FilterKey = 'all' | 'added' | 'removed' | 'grown' | 'shrunk';
