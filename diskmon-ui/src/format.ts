import type { ChangeKind, SnapshotRow } from './types';

export function usableSnapshot(s: SnapshotRow): boolean {
  return s.status === 'complete' || s.status === 'partial';
}

export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(2)} ${units[i]}`;
}

export function fmtTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDelta(n: number): string {
  if (n === 0) return '0 B';
  return (n > 0 ? '+' : '−') + humanBytes(Math.abs(n));
}

export function fmtPct(p: number | null, reliable = true): string {
  if (!reliable) return '—';
  if (p === null || !Number.isFinite(p)) return '—';
  const s = Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(1);
  return (p > 0 ? '+' : '') + s + '%';
}

export function statusLabel(s: string): string {
  switch (s) {
    case 'complete': return '完整';
    case 'partial': return '不完整';
    case 'cancelled': return '已取消';
    case 'running': return '扫描中';
    case 'failed': return '扫描失败';
    default: return s;
  }
}

export function statusBadge(s: string): string {
  switch (s) {
    case 'complete': return 'ok';
    case 'partial': return 'warn';
    case 'cancelled': return 'del';
    case 'running': return 'info';
    case 'failed': return 'del';
    default: return 'same';
  }
}

export function kindLabel(k: ChangeKind): string {
  switch (k) {
    case 'added': return '新增';
    case 'removed': return '删除';
    case 'grown': return '变大';
    case 'shrunk': return '变小';
    default: return '未变';
  }
}

export function kindBadge(k: ChangeKind): string {
  switch (k) {
    case 'added': return 'add';
    case 'removed': return 'del';
    case 'grown': return 'up';
    case 'shrunk': return 'down';
    default: return 'same';
  }
}

/** 与 Rust 侧 normalize_reveal_path 保持一致：统一分隔符/盘符/前缀，只放行 C 盘。 */
export function normalizeWinPath(raw: string): string | null {
  let s = raw.trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\');
  s = s.replace(/^\\\\\?\\/, '');
  s = s.replace(/^67:\\/, 'C:\\');
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.toLowerCase() === 'c:') s = 'C:\\';
  return s.startsWith('C:\\') && !s.split('\\').some((part) => part === '.' || part === '..') ? s : null;
}

export function errorKindLabel(k: string): string {
  switch (k) {
    case 'permission': return '权限不足';
    case 'disappeared': return '文件消失';
    case 'reparse': return '重解析点';
    default: return 'I/O 错误';
  }
}
