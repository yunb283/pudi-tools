import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isDesktop, listenProgress } from './api';
import { usableSnapshot } from './format';
import type {
  OverviewPayload, OverviewRankings, Progress, ScheduleInfo, Settings, ViewKey,
} from './types';
import {
  CompareView, OverviewView, ScanView, SettingsView, SnapshotsView,
} from './views';

const IDLE: Progress = {
  running: false, snapshot_id: null, files: 0, dirs: 0, bytes: 0,
  errors: 0, reparse: 0, current_path: 'C:\\', started_at: 0,
  percent: 0, phase: 'idle', message: '尚未开始扫描',
};

const EMPTY_SETTINGS: Settings = {
  max_snapshots: 30, auto_prune: true, follow_reparse: false, read_content: false, root_path: 'C:\\',
};
const EMPTY_SCHEDULE: ScheduleInfo = {
  enabled: false, frequency: 'daily', time_hhmm: '09:00', weekday: 1,
  task_name: 'PudiTools DiskMonitor C', registered: false, detail: '',
};
const OVERVIEW_KEY = 'diskmon.overview.1';

function readOverview(): OverviewPayload | null {
  if (!isDesktop()) return null;
  try {
    const data = JSON.parse(localStorage.getItem(OVERVIEW_KEY) ?? 'null') as OverviewPayload | null;
    return Array.isArray(data?.snapshots) && Array.isArray(data?.folders)
      && Array.isArray(data?.trend) && data?.settings && data?.volume ? data : null;
  } catch { return null; }
}

function cacheOverview(data: OverviewPayload) {
  if (!isDesktop()) return;
  try {
    if (data.latest) {
      localStorage.setItem(OVERVIEW_KEY, JSON.stringify({
        ...data, snapshots: data.snapshots.filter((s) => s.status !== 'running'),
      }));
    } else {
      localStorage.removeItem(OVERVIEW_KEY);
    }
  } catch { /* SQLite 仍然保留历史快照 */ }
}

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'overview', label: '概览首页' },
  { key: 'scan', label: '扫描进度' },
  { key: 'snapshots', label: '快照管理' },
  { key: 'compare', label: '变化对比' },
  { key: 'settings', label: '扫描设置' },
];

export default function App() {
  const [view, setView] = useState<ViewKey>('overview');
  const [overview, setOverview] = useState(readOverview);
  const [verified, setVerified] = useState(false);
  const [rankError, setRankError] = useState(false);
  const [progress, setProgress] = useState(IDLE);
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [baseId, setBaseId] = useState<number | null>(null);
  const refreshId = useRef(0);
  const progressVersion = useRef(0);
  const progressRef = useRef(IDLE);
  const rankRequest = useRef<{ key: string; promise: Promise<OverviewRankings> } | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const desktop = isDesktop();
  const snapshots = overview?.snapshots ?? [];
  const settings = overview?.settings ?? EMPTY_SETTINGS;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3400);
  }, []);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try {
      const fresh = await invoke<OverviewPayload>('dm_overview');
      if (id !== refreshId.current) return;
      setOverview(fresh);
      setVerified(true);
      setRankError(false);
      cacheOverview(fresh);
      const usable = fresh.snapshots.filter(usableSnapshot);
      setBaseId((prev) => usable.some((s) => s.id === prev) ? prev : (usable[1]?.id ?? usable[0]?.id ?? null));
      if (fresh.pair && !fresh.rankings) {
        const [a, b] = fresh.pair;
        const key = fresh.pair.join(':');
        if (rankRequest.current?.key !== key) {
          const promise = invoke<OverviewRankings>('dm_overview_rankings', { a, b });
          rankRequest.current = { key, promise };
          const clear = () => { if (rankRequest.current?.promise === promise) rankRequest.current = null; };
          void promise.then(clear, clear);
        }
        void rankRequest.current.promise.then((rankings) => {
          if (id !== refreshId.current) return;
          const enriched = { ...fresh, rankings };
          setOverview(enriched);
          cacheOverview(enriched);
        }).catch((e) => {
          if (id === refreshId.current) {
            setRankError(true);
            showToast(String(e));
          }
        });
      }
    } catch (e) {
      if (id === refreshId.current) showToast(e instanceof Error ? e.message : String(e));
    }
  }, [showToast]);

  const applyProgress = useCallback((p: Progress) => {
    progressVersion.current++;
    const previous = progressRef.current;
    progressRef.current = p;
    setProgress(p);
    if (previous.running && !p.running) void refresh();
    else if (p.running && p.snapshot_id !== null && p.snapshot_id !== previous.snapshot_id) void refresh();
  }, [refresh]);

  const syncProgress = useCallback(async () => {
    const version = progressVersion.current;
    try {
      const p = await invoke<Progress>('dm_scan_progress');
      if (version === progressVersion.current) applyProgress(p);
    } catch { /* 扫描也会通过事件报告状态 */ }
  }, [applyProgress]);

  // 主程序 showTab 只切 .hidden，React 用 MutationObserver 感知切入并刷新。
  useEffect(() => {
    const page = document.getElementById('page-diskmon');
    if (!page) return;
    let visible = false;
    const check = () => {
      const next = !page.classList.contains('hidden');
      if (next && !visible) {
        void refresh();
        void syncProgress();
      }
      visible = next;
    };
    const obs = new MutationObserver(check);
    obs.observe(page, { attributes: true, attributeFilter: ['class'] });
    check();
    return () => obs.disconnect();
  }, [refresh, syncProgress]);

  // Rust 后台线程推送进度；同时保留 1s 轮询兜底（事件漏收时仍能恢复）。
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    void listenProgress(applyProgress, () => {
      if (progressRef.current.running) void syncProgress();
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    }).catch(() => {});
    return () => { cancelled = true; off?.(); };
  }, [applyProgress, syncProgress]);

  useEffect(() => {
    if (!progress.running) return;
    const id = window.setInterval(() => void syncProgress(), 1000);
    return () => window.clearInterval(id);
  }, [progress.running, syncProgress]);

  const scheduledScanRunning = !progress.running && snapshots.some((s) => s.status === 'running');
  useEffect(() => {
    if (!scheduledScanRunning) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [scheduledScanRunning, refresh]);

  useEffect(() => {
    if (view !== 'settings') return;
    let active = true;
    void invoke<ScheduleInfo>('dm_schedule')
      .then((s) => { if (active) setSchedule((saved) => saved ?? s); })
      .catch((e) => { if (active) showToast(String(e)); });
    return () => { active = false; setSchedule(null); };
  }, [view, showToast]);

  // 内层页签药丸位置
  useEffect(() => {
    const tabs = tabsRef.current;
    const el = tabs?.querySelector<HTMLElement>('.dm-tab.active');
    const ind = indRef.current;
    if (!tabs || !el || !ind) return;
    const layout = () => {
      if (!el.offsetWidth) return;
      ind.style.setProperty('--x', `${el.offsetLeft}px`);
      ind.style.setProperty('--y', `${el.offsetTop}px`);
      ind.style.setProperty('--w', `${el.offsetWidth}px`);
      ind.style.setProperty('--h', `${el.offsetHeight}px`);
      ind.classList.add('on');
    };
    const observer = new ResizeObserver(layout);
    observer.observe(tabs);
    layout();
    return () => observer.disconnect();
  }, [view]);

  const run = useCallback(async (cmd: string, args?: Record<string, unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      const version = progressVersion.current;
      const result = await invoke<unknown>(cmd, args);
      if (cmd === 'dm_start_scan') {
        if (version === progressVersion.current) applyProgress(result as Progress);
      } else if (cmd === 'dm_set_schedule' || cmd === 'dm_remove_schedule') {
        setSchedule(result as ScheduleInfo);
      } else if (cmd !== 'dm_reveal' && cmd !== 'dm_cancel_scan') {
        await refresh();
      }
      if (okMsg) showToast(okMsg);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [applyProgress, refresh, showToast]);

  const common = { desktop, busy: busy || (desktop && !verified), run, refresh, showToast };
  const latest = progress.snapshot_id === null
    ? overview?.latest ?? null
    : snapshots.find((s) => s.id === progress.snapshot_id) ?? null;

  return (
    <div className="dm-root">
      <div className="dm-shell">
        <div className="dm-tabs" ref={tabsRef}>
          <span className="dm-ind" ref={indRef} aria-hidden="true" />
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={'dm-tab' + (view === v.key ? ' active' : '')}
              data-view={v.key}
              onClick={() => setView(v.key)}
            >{v.label}</button>
          ))}
          <span className="grow" />
          <span className="dm-sub" style={{ paddingRight: 8 }}>
            监测目标固定 C:\ · 仅元数据
            {!desktop && <span className="bd warn" style={{ marginLeft: 8 }}>浏览器预览 · 演示数据</span>}
          </span>
        </div>

        <div className="dm-views">
          {view === 'overview' && (
            <OverviewView
              {...common}
              overview={overview}
              cached={!verified && overview !== null}
              rankError={rankError}
              progress={progress}
              onGo={setView}
              onStartScan={async () => {
                if (await run('dm_start_scan', undefined, '扫描已启动')) setView('scan');
              }}
            />
          )}
          {view === 'scan' && (
            <ScanView
              {...common}
              progress={progress}
              latest={latest}
              onStartScan={() => void run('dm_start_scan', undefined, '扫描已启动')}
              onCancel={() => void run('dm_cancel_scan', undefined, '已请求取消扫描')}
            />
          )}
          {view === 'snapshots' && (
            <SnapshotsView
              {...common}
              snapshots={snapshots}
              settings={settings}
              baseId={baseId}
              setBaseId={setBaseId}
              onGo={setView}
            />
          )}
          {view === 'compare' && (
            <CompareView
              {...common}
              snapshots={snapshots}
              baseId={baseId}
              setBaseId={setBaseId}
              onReveal={(p: string) => void run('dm_reveal', { path: p }, '已在资源管理器中定位')}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              {...common}
              settings={settings}
              schedule={schedule ?? EMPTY_SCHEDULE}
              scheduleReady={schedule !== null}
              dbPath={overview?.db_path ?? '—'}
            />
          )}
        </div>
      </div>
      <div className={'dm-toast' + (toast ? ' on' : '')}>{toast}</div>
    </div>
  );
}
