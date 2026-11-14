import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from './api';
import {
  errorKindLabel, fmtDateTime, fmtDelta, fmtPct, fmtTime, humanBytes,
  kindBadge, kindLabel, statusBadge, statusLabel, usableSnapshot,
} from './format';
import type {
  ComparePayload, DiffRow, FilterKey, FolderRankRow, OverviewPayload, Progress, ScanError,
  ScheduleInfo, Settings, SnapshotRow, SortKey, TrendPoint, ViewKey,
} from './types';

export interface CommonProps {
  desktop: boolean;
  busy: boolean;
  run: (cmd: string, args?: Record<string, unknown>, okMsg?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  showToast: (msg: string) => void;
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`bd ${cls}`}>{children}</span>;
}

function WarnBar({ children }: { children: ReactNode }) {
  return <div className="dm-warnbar"><span className="ico">!</span><div>{children}</div></div>;
}

function Card({ title, sub, right, children, transparent, cls }: {
  title?: string; sub?: string; right?: ReactNode; children: ReactNode;
  transparent?: boolean; cls?: string;
}) {
  return (
    <section className={'dm-card' + (transparent ? ' transparent' : '') + (cls ? ' ' + cls : '')}>
      {(title || right) && (
        <div className="dm-head">
          {title && <span className="dm-title">{title}</span>}
          {sub && <span className="dm-sub">{sub}</span>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'growth', label: '增长大小' }, { key: 'pct', label: '增长百分比' }, { key: 'size', label: '当前体积' },
];
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'grown', label: '变大' }, { key: 'added', label: '新增' },
  { key: 'removed', label: '删除' }, { key: 'shrunk', label: '变小' },
];

function TrendChart({ points }: { points: TrendPoint[] }) {
  const pts = useMemo(() => {
    if (points.length < 2) return [];
    const vals = points.map((p) => p.total_bytes);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return points.map((p, i) => ({
      x: 76 + (i * 404) / (points.length - 1),
      y: 108 - ((p.total_bytes - min) / span) * 78,
      p,
    }));
  }, [points]);
  if (!pts.length) {
    return <div className="dm-hint">至少需要两次快照才能绘制趋势。</div>;
  }
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
  const area = `${line} L480,118 L76,118 Z`;
  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 520 140" role="img" aria-label="C 盘快照体积趋势">
        {[30, 69, 108].map((y) => <line key={y} className="chart-grid" x1="76" x2="480" y1={y} y2={y} />)}
        <path className="chart-area" d={area} />
        <path className="chart-line" d={line} />
        {pts.map((q) => <circle key={q.p.id} className="chart-dot" cx={q.x} cy={q.y} r="3.2" />)}
        <text className="chart-label" x="2" y="34">{humanBytes(Math.max(...points.map((p) => p.total_bytes)))}</text>
        <text className="chart-label" x="2" y="112">{humanBytes(Math.min(...points.map((p) => p.total_bytes)))}</text>
        <text className="chart-label" x="76" y="132">{fmtTime(pts[0].p.started_at)}</text>
        <text className="chart-label" x="440" y="132">{fmtTime(pts[pts.length - 1].p.started_at)}</text>
      </svg>
      <div className="chart-legend"><span><i />快照统计体积（可访问文件之和）</span><span className="dm-sub">与卷已用空间口径不同</span></div>
    </div>
  );
}

// ─────────────────────────────── 概览首页 ───────────────────────────────

export function OverviewView(props: CommonProps & {
  overview: OverviewPayload | null;
  cached: boolean;
  rankError: boolean;
  progress: Progress;
  onGo: (v: ViewKey) => void;
  onStartScan: () => Promise<void>;
}) {
  const { overview: o, cached, rankError, onGo, onStartScan, desktop, busy } = props;
  const scanRunning = props.progress.running;
  const [rankSort, setRankSort] = useState<SortKey>('growth');
  const usedPct = o && o.volume.total > 0 ? (o.volume.used / o.volume.total) * 100 : 0;
  const ranking = o?.rankings?.[rankSort] ?? [];
  const trend = o?.trend ?? [];
  const folders: FolderRankRow[] = o?.folders ?? [];
  const folderMax = folders.reduce((m, f) => Math.max(m, f.size_bytes), 1);
  const folderTotal = o?.folder_total_bytes ?? 0;
  const foldersReady = folders.length > 0;

  // 醒目扫描入口：桌面端直接发起扫描并跳到进度页；浏览器预览只给出明确提示。
  const scanCta = (
    <button
      className={'dm-scan-cta' + (busy || scanRunning ? ' busy' : '')}
      disabled={busy || scanRunning}
      title={desktop ? '立即开始一次 C 盘快照扫描（仅收集文件元数据）' : '浏览器预览模式不执行磁盘操作'}
      onClick={() => {
        if (!desktop) {
          props.showToast('浏览器预览模式不执行磁盘操作，请在桌面端运行');
          return;
        }
        void onStartScan();
      }}
    >
      <span className="cta-ico" aria-hidden="true">▶</span>
      <span>{scanRunning ? '扫描中…' : !o ? '读取中…' : '立即扫描'}</span>
    </button>
  );

  return (
    <div className="dm-view" data-view="overview">
      {!desktop && <WarnBar>当前是浏览器预览模式，以下为<b>演示数据</b>；真实扫描、写库、计划任务均需在桌面端运行。</WarnBar>}
      {cached && <div className="dm-hint" role="status">正在显示上次保存的扫描结果</div>}
      {o && !o.reliable && o.has_pair && (
        <WarnBar>
          对比快照状态为 <b>{statusLabel(o.status_a)} → {statusLabel(o.status_b)}</b>。净增长与排行榜仅代表两次快照中可访问文件的统计差异。
        </WarnBar>
      )}

      <div className="dm-grid g-4">
        <Card cls="cta-card"><div className="kpi">
          <div className="kpi-head"><span className="kpi-label">C 盘使用率</span>{scanCta}</div>
          <span className="kpi-val">{o?.volume.total ? usedPct.toFixed(1) : '—'}{o?.volume.total ? <small>%</small> : null}</span>
          <span className="kpi-foot">{o?.volume.total ? `${humanBytes(o.volume.used)} / ${humanBytes(o.volume.total)}` : '等待读取卷信息'}</span>
        </div></Card>
        <Card><div className="kpi"><span className="kpi-label">最近扫描</span><span className="kpi-val" style={{ fontSize: 18 }}>{fmtTime(o?.latest?.started_at ?? 0)}</span><span className="kpi-foot">{o?.latest ? `快照 #${o.latest.id} · ${statusLabel(o.latest.status)}` : '尚无快照'}</span></div></Card>
        <Card><div className="kpi"><span className="kpi-label">历史快照</span><span className="kpi-val">{o?.snapshot_count ?? '—'}<small>个</small></span><span className="kpi-foot">根目录均为 C:\</span></div></Card>
        <Card><div className={'kpi ' + ((o?.net_delta ?? 0) > 0 ? 'up' : (o?.net_delta ?? 0) < 0 ? 'down' : '')}>
          <span className="kpi-label">最近两次净变化</span>
          <span className="kpi-val" style={{ fontSize: 19 }}>{o?.has_pair ? fmtDelta(o.net_delta) : '—'}</span>
          <span className="kpi-foot">{o?.has_pair ? `${statusLabel(o.status_a)} → ${statusLabel(o.status_b)}` : '至少需要两次快照'}</span>
        </div></Card>
      </div>

      <div className="dm-grid g-overview">
        <Card title="C 盘使用量" sub="来自系统卷信息 · 只读查询" right={<button className="btn tiny" onClick={() => void props.refresh()}>刷新</button>}>
          <div className="dm-disk-row">
            <span className="dm-disk-name">C:</span>
            <div className={'dm-bar big' + (usedPct > 85 ? ' warn' : '')}><i style={{ width: `${Math.min(100, usedPct)}%` }} /></div>
            <span className="dm-disk-num">{humanBytes(o?.volume.used ?? 0)}</span>
          </div>
          <div className="dm-grid g-3">
            <div className="kpi"><span className="kpi-label">已用</span><span className="dm-strong">{humanBytes(o?.volume.used ?? 0)}</span></div>
            <div className="kpi"><span className="kpi-label">可用</span><span className="dm-strong">{humanBytes(o?.volume.free ?? 0)}</span></div>
            <div className="kpi"><span className="kpi-label">使用率</span><span className="dm-strong">{usedPct.toFixed(1)}%</span></div>
          </div>
          <div className="dm-hint">卷容量来自系统卷信息；快照内统计的是可访问文件的逻辑大小之和，二者口径不同，不做直接相减。监测范围固定为 C:\，不扫描其它磁盘、不提供自选文件夹。</div>
        </Card>

        <Card title="空间变化排行榜" sub={o?.has_pair ? '最近两次快照' : '暂无可比快照'} right={
          <div className="dm-row">{SORTS.map((s) => (
            <button key={s.key} className={'btn tiny' + (rankSort === s.key ? ' on' : '')} onClick={() => setRankSort(s.key)}>{s.label}</button>
          ))}</div>
        }>
          <div className="tree-scroll" style={{ maxHeight: 250 }}>
            <table className="dm-table rank-table">
              <thead><tr><th>#</th><th>路径</th><th className="num">变化</th><th>状态</th></tr></thead>
              <tbody>
                {ranking.map((r, i) => (
                  <tr key={r.path}>
                    <td><span className={'rank r' + (i + 1)}>{i + 1}</span></td>
                    <td className="path dm-mono" title={r.path}>{r.path}</td>
                    <td className={'num ' + (r.delta >= 0 ? 'val-up' : 'val-down')}>{fmtDelta(r.delta)}</td>
                    <td><Badge cls={kindBadge(r.kind)}>{kindLabel(r.kind)}</Badge></td>
                  </tr>
                ))}
              {!ranking.length && <tr><td colSpan={4} className="dm-hint">
                {rankError ? '排行读取失败，请点击刷新重试。'
                  : o?.rankings ? '两次快照没有变化项。'
                  : o?.has_pair ? '正在计算变化排行…'
                  : o ? '至少需要两次可用快照。' : '正在读取快照…'}
              </td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card
        title="文件夹占用空间排行"
        sub={foldersReady ? `基于快照 #${o?.folder_snapshot_id} · 前 ${folders.length} 个目录` : '等待第一次扫描'}
        right={
          <div className="dm-row">
            {foldersReady && o?.folder_status !== 'complete' && (
              <Badge cls="warn">{statusLabel(o?.folder_status ?? '')} · 仅覆盖可访问目录</Badge>
            )}
            <button className="btn tiny" onClick={() => onGo('compare')}>逐级展开目录树 →</button>
          </div>
        }
      >
        {foldersReady ? (
          <>
            <div className="tree-scroll" style={{ maxHeight: 286 }}>
              <table className="dm-table folder-table">
                <thead><tr>
                  <th style={{ width: 34 }}>#</th>
                  <th>文件夹</th>
                  <th>占用（相对榜首）</th>
                  <th className="num">大小</th>
                  <th className="num">占快照统计</th>
                  <th style={{ width: 62 }}>操作</th>
                </tr></thead>
                <tbody>
                  {folders.map((f, i) => (
                    <tr key={f.path}>
                      <td><span className={'rank r' + (i + 1)}>{i + 1}</span></td>
                      <td className="path dm-mono" title={f.path}>{f.path}</td>
                      <td><div className="dm-bar folder-bar"><i style={{ width: `${Math.max(2, (f.size_bytes / folderMax) * 100)}%` }} /></div></td>
                      <td className="num dm-strong">{humanBytes(f.size_bytes)}</td>
                      <td className="num">{folderTotal > 0 ? `${((f.size_bytes / folderTotal) * 100).toFixed(1)}%` : '—'}</td>
                      <td>
                        <button className="btn tiny" disabled={!desktop}
                          title={desktop ? '在资源管理器中定位' : '浏览器预览模式不可用'}
                          onClick={() => void props.run('dm_reveal', { path: f.path }, '已在资源管理器中定位')}>定位</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dm-hint">
              目录大小为<b>递归汇总值（包含所有子目录）</b>，因此父目录必然不小于子目录并排在前面；每个文件只归属其直接父目录一次，不会重复计数。榜单不含根目录 C:\ 与重解析点；占比以该快照统计到的可访问文件总量为分母，与卷已用空间口径不同，不做直接相减。
              {o?.folder_status !== 'complete' && ' 该快照不完整，排行只覆盖可访问目录，不能作为全盘精确占用结论。'}
            </div>
          </>
        ) : o ? (
          <div className="dm-hint">尚无可用快照。点击左上角<b>「立即扫描」</b>生成第一次 C 盘快照后，这里会按文件夹占用空间从大到小排列，并可在变化对比页逐级展开到文件。</div>
        ) : <div className="dm-hint">正在读取上次扫描结果…</div>}
      </Card>

      <Card title="历史趋势" sub={`最近 ${trend.length} 次快照`} right={
        <div className="dm-row">
          <button className="btn tiny" onClick={() => onGo('scan')}>扫描进度 →</button>
          <button className="btn tiny" onClick={() => onGo('snapshots')}>查看快照 →</button>
          <button className="btn tiny" onClick={() => onGo('compare')}>变化对比 →</button>
        </div>
      }>
        <TrendChart points={trend} />
      </Card>
      <div className="footnote">首页只做仪表盘与排行，不承载重操作；扫描、快照、对比各自独立成页。</div>
    </div>
  );
}

// ─────────────────────────────── 扫描进度 ───────────────────────────────

export function ScanView(props: CommonProps & {
  progress: Progress;
  latest: SnapshotRow | null;
  onStartScan: () => void;
  onCancel: () => void;
}) {
  const { progress: p, latest, onStartScan, onCancel, desktop, busy } = props;
  const [errors, setErrors] = useState<ScanError[]>([]);
  const [errorsLoaded, setErrorsLoaded] = useState(false);
  const latestId = latest?.id;
  const hasResults = latest !== null && usableSnapshot(latest);
  useEffect(() => {
    setErrors([]);
    setErrorsLoaded(false);
    if (latestId === undefined || !hasResults) return;
    let active = true;
    void invoke<ScanError[]>('dm_snapshot_errors', { id: latestId })
      .then((rows) => { if (active) { setErrors(rows); setErrorsLoaded(true); } })
      .catch((e) => { if (active) props.showToast(String(e)); });
    return () => { active = false; };
  }, [latestId, hasResults, props.showToast]);

  const pct = Math.max(0, Math.min(100, p.percent));
  const partial = latest?.status === 'partial' && !p.running;
  const historical = p.phase === 'idle' && hasResults ? latest : null;
  return (
    <div className="dm-view" data-view="scan">
      {!desktop && <WarnBar>浏览器预览模式<b>不执行任何磁盘扫描或写库</b>；此处展示的是界面形态，请在桌面端运行本程序以扫描真实 C 盘。</WarnBar>}
      {partial && (
        <WarnBar>
          最近扫描记录了 {latest.error_count} 条异常，快照标记为「不完整」。对比页会隐藏变化百分比。
        </WarnBar>
      )}

      <div className="dm-grid g-2">
        <Card title="扫描进度" sub={p.running ? '后台线程运行中' : '空闲'} right={
          <div className="dm-row">
            <button className="btn primary" disabled={!desktop || busy || p.running} onClick={onStartScan}>开始扫描 C:\</button>
            <button className="btn danger" disabled={!desktop || busy || !p.running} onClick={onCancel}>取消扫描</button>
          </div>
        }>
          <div className="dm-row" style={{ justifyContent: 'space-between' }}>
            <span className="scan-big">{pct.toFixed(0)}<small style={{ fontSize: 13, color: 'var(--muted-a6)' }}>%</small></span>
            <Badge cls={p.running ? 'info' : p.phase === 'done' ? 'ok' : 'same'}>
              {p.running ? '扫描中' : p.phase === 'done' ? '已完成' : p.phase === 'cancelled' ? '已取消' : p.phase === 'failed' ? '扫描失败' : '空闲'}
            </Badge>
          </div>
          <div className="scan-progress"><i style={{ width: `${pct}%` }} /></div>
          <div className="dm-hint">遍历阶段进度为基于已扫描条目数的<b>估算值</b>（C 盘总量事先未知），写库阶段为真实比例。</div>
          <div className="dm-field"><span>当前扫描路径</span><div className="scan-cur">{p.current_path || 'C:\\'}</div></div>
          <div className="dm-hint">{p.message || '尚未开始扫描'}</div>
        </Card>

        <Card title="扫描统计" sub={historical ? `上次快照 #${historical.id}` : '仅元数据'}>
          <div className="dm-grid g-2">
            <div className="kpi"><span className="kpi-label">已扫描文件</span><span className="kpi-val">{(historical?.file_count ?? p.files).toLocaleString()}</span></div>
            <div className="kpi"><span className="kpi-label">已扫描目录</span><span className="kpi-val">{(historical?.dir_count ?? p.dirs).toLocaleString()}</span></div>
            <div className="kpi"><span className="kpi-label">逻辑大小之和</span><span className="kpi-val" style={{ fontSize: 18 }}>{humanBytes(historical?.total_bytes ?? p.bytes)}</span></div>
            <div className="kpi"><span className="kpi-label">跳过重解析点</span><span className="kpi-val">{(historical?.reparse_count ?? p.reparse).toLocaleString()}</span></div>
          </div>
          <div className="dm-hint">符号链接 / Junction 默认不跟随且不计数，避免循环与重复统计；异常明细最多保留 2,000 条。</div>
        </Card>
      </div>

      <Card title="扫描配置" sub="v1 固定项">
        <table className="dm-table">
          <tbody>
            <tr><td>扫描范围</td><td className="dm-mono dm-strong">C:\（固定 · v1 唯一目标）</td><td>不可更改</td></tr>
            <tr><td>读取文件内容</td><td><Badge cls="ok">禁止（仅元数据）</Badge></td><td>不打开、不上传任何文件</td></tr>
            <tr><td>跟随符号链接 / Junction</td><td><Badge cls="ok">否</Badge></td><td>默认跳过重解析点</td></tr>
            <tr><td>自动删除系统文件</td><td><Badge cls="ok">禁止</Badge></td><td>清理只作用于本程序快照记录</td></tr>
          </tbody>
        </table>
      </Card>

      <Card title="异常记录" sub={latest ? `快照 #${latest.id}` : '暂无'} right={<span className="dm-sub">共 {p.running ? p.errors : latest?.error_count ?? 0} 条</span>}>
        <div className="tree-scroll" style={{ maxHeight: 220 }}>
          <table className="dm-table">
            <thead><tr><th>路径</th><th>类型</th><th>说明</th></tr></thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={`${e.path}-${i}`}>
                  <td className="path dm-mono" title={e.path}>{e.path}</td>
                  <td><Badge cls="warn">{errorKindLabel(e.kind)}</Badge></td>
                  <td className="dm-sub">{e.message}</td>
                </tr>
              ))}
              {!errors.length && <tr><td colSpan={3} className="dm-hint">
                {p.running ? '扫描结束后可查看明细。' : latest && usableSnapshot(latest) && !errorsLoaded ? '尚未读取异常明细。' : '没有异常记录。'}
              </td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────── 快照管理 ───────────────────────────────

export function SnapshotsView(props: CommonProps & {
  snapshots: SnapshotRow[];
  settings: Settings;
  baseId: number | null;
  setBaseId: (id: number) => void;
  onGo: (v: ViewKey) => void;
}) {
  const { snapshots, settings, baseId, setBaseId, onGo, desktop, busy, run } = props;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [max, setMax] = useState<number>(settings.max_snapshots);
  const [autoPrune, setAutoPrune] = useState<boolean>(settings.auto_prune);
  useEffect(() => { setMax(settings.max_snapshots); setAutoPrune(settings.auto_prune); }, [settings.max_snapshots, settings.auto_prune]);

  const togglePick = (id: number) => setPicked((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="dm-view" data-view="snapshots">
      <Card title="历史快照" sub={`共 ${snapshots.length} 个 · 根目录均为 C:\\`} right={
        <div className="dm-row">
          <button className="btn tiny" onClick={() => onGo('compare')}>变化对比 →</button>
          <button className="btn tiny danger" disabled={!desktop || busy || !picked.size}
            onClick={() => void run('dm_delete_snapshots', { ids: [...picked] }, `已删除 ${picked.size} 个快照`).then((ok) => { if (ok) setPicked(new Set()); })}>
            删除选中（{picked.size}）
          </button>
        </div>
      }>
        <div className="tree-scroll" style={{ maxHeight: 380 }}>
          <table className="dm-table">
            <thead><tr><th>A</th><th></th><th>#</th><th>扫描时间</th><th>状态</th><th className="num">文件数</th><th className="num">目录数</th><th className="num">统计体积</th><th className="num">异常</th></tr></thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td><input type="radio" name="dm-base" disabled={!usableSnapshot(s)} checked={baseId === s.id} onChange={() => setBaseId(s.id)} title="设为变化对比的基准快照 A" /></td>
                  <td><input type="checkbox" checked={picked.has(s.id)} onChange={() => togglePick(s.id)} disabled={s.status === 'running'} title="选择删除" /></td>
                  <td className="dm-mono dm-strong">{s.id}</td>
                  <td className="dm-mono">{fmtDateTime(s.started_at)}</td>
                  <td><Badge cls={statusBadge(s.status)}>{statusLabel(s.status)}</Badge></td>
                  <td className="num">{s.file_count.toLocaleString()}</td>
                  <td className="num">{s.dir_count.toLocaleString()}</td>
                  <td className="num">{humanBytes(s.total_bytes)}</td>
                  <td className="num">{s.error_count}</td>
                </tr>
              ))}
              {!snapshots.length && <tr><td colSpan={9} className="dm-hint">还没有快照，请先执行一次扫描。</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="dm-hint">单选列用于指定「基准快照 A」，对比快照 B 在对比页选择；已取消与正在运行的快照不可作为精确结论依据。所有快照根目录固定为 C:\，可直接横向比较。</div>
      </Card>

      <div className="dm-grid g-2">
        <Card title="清理策略" sub="仅清理本程序的快照记录">
          <div className="dm-grid g-2">
            <label className="dm-field"><span>最大存储数量</span><input type="number" min={2} max={500} value={max} onChange={(e) => setMax(Number(e.target.value))} /></label>
            <div className="dm-field"><span>自动清理</span><label className="dm-lbl"><input type="checkbox" checked={autoPrune} onChange={(e) => setAutoPrune(e.target.checked)} />扫描结束后自动保留最近记录</label></div>
          </div>
          <div className="dm-row">
            <button className="btn" disabled={!desktop || busy || !Number.isInteger(max) || max < 2 || max > 500} onClick={() => void run('dm_set_settings', { maxSnapshots: max, autoPrune }, '清理策略已保存')}>保存策略</button>
            <button className="btn" disabled={!desktop || busy} onClick={() => void run('dm_prune', undefined, '已按策略清理旧快照')}>立即清理</button>
          </div>
          <div className="dm-hint">清理只删除 SQLite 中的快照 / 条目 / 异常记录，<b>绝不会删除磁盘上的任何文件</b>。</div>
        </Card>
        <Card title="快照状态说明">
          <table className="dm-table">
            <tbody>
              <tr><td><Badge cls="ok">完整</Badge></td><td>全部可访问条目扫描成功，可作为精确对比依据</td></tr>
              <tr><td><Badge cls="warn">不完整</Badge></td><td>存在权限不足 / 文件消失，对比时隐藏百分比并显示警示</td></tr>
              <tr><td><Badge cls="del">已取消</Badge></td><td>无数据，禁止作为对比依据</td></tr>
              <tr><td><Badge cls="del">扫描失败</Badge></td><td>无可用数据，禁止作为对比依据</td></tr>
              <tr><td><Badge cls="info">扫描中</Badge></td><td>不可删除、不可对比</td></tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────── 变化对比 ───────────────────────────────

export function CompareView(props: CommonProps & {
  snapshots: SnapshotRow[];
  baseId: number | null;
  setBaseId: (id: number) => void;
  onReveal: (path: string) => void;
}) {
  const { snapshots, baseId, setBaseId, onReveal, desktop, showToast } = props;
  const usable = snapshots.filter(usableSnapshot);
  const a = usable.some((s) => s.id === baseId) ? baseId : (usable[1]?.id ?? usable[0]?.id ?? null);
  const [compareId, setB] = useState<number | null>(null);
  const b = usable.some((s) => s.id === compareId && s.id !== a) ? compareId : (usable.find((s) => s.id !== a)?.id ?? null);
  const [sort, setSort] = useState<SortKey>('growth');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [result, setResult] = useState<{ key: string; payload: ComparePayload } | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, DiffRow[]>>({});
  const request = useRef<AbortController | null>(null);
  const pendingChildren = useRef(new Set<string>());
  const key = `${a}:${b}:${sort}:${filter}`;
  const payload = result?.key === key ? result.payload : null;

  useEffect(() => {
    setResult(null);
    setChildren({});
    setExpanded(new Set());
    pendingChildren.current.clear();
    if (!a || !b || a === b) { setLoading(false); return; }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    void invoke<ComparePayload>('dm_compare', { a, b, sort, filter, limit: 300 })
      .then((res) => {
        if (controller.signal.aborted) return;
        setResult({ key, payload: res });
      })
      .catch((e) => { if (!controller.signal.aborted) showToast(String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [a, b, key, sort, filter, showToast]);

  const all = useMemo(() => {
    const map = new Map<string, DiffRow>();
    if (payload) {
      for (const r of payload.rows) map.set(r.path, r);
      for (const list of Object.values(children)) {
        for (const r of list) if (!map.has(r.path)) map.set(r.path, r);
      }
    }
    return map;
  }, [payload, children]);

  interface Visible { row: DiffRow; depth: number }
  const visible = useMemo<Visible[]>(() => {
    const byParent = new Map<string, DiffRow[]>();
    for (const r of all.values()) {
      const key = r.parent ?? '';
      const list = byParent.get(key) ?? [];
      list.push(r);
      byParent.set(key, list);
    }
    for (const list of byParent.values()) {
      list.sort((x, y) => sort === 'pct'
        ? (y.pct ?? -Infinity) - (x.pct ?? -Infinity)
        : sort === 'size' ? y.size_b - x.size_b : y.delta - x.delta);
    }
    const roots = [...all.values()].filter((r) => !r.parent || !all.has(r.parent));
    roots.sort((x, y) => x.path.localeCompare(y.path));
    const out: Visible[] = [];
    const seen = new Set<string>();
    const walk = (r: DiffRow, depth: number) => {
      if (seen.has(r.path)) return;
      seen.add(r.path);
      out.push({ row: r, depth });
      if (r.is_dir && expanded.has(r.path)) {
        for (const c of byParent.get(r.path) ?? []) walk(c, depth + 1);
      }
    };
    // 只输出从根出发、沿已展开目录可达的节点；折叠分支的后代不渲染
    for (const r of roots) walk(r, 0);
    return out;
  }, [all, expanded, sort]);

  const toggle = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(path); return n; });
      return;
    }
    setExpanded((prev) => new Set(prev).add(path));
    if (path in children || pendingChildren.current.has(path) || !a || !b || !payload) return;
    const controller = request.current;
    pendingChildren.current.add(path);
    try {
      const cs = await invoke<DiffRow[]>('dm_compare_children', { a, b, parent: path, sort, limit: 500 });
      if (!controller?.signal.aborted) setChildren((m) => ({ ...m, [path]: cs }));
    } catch (e) {
      if (!controller?.signal.aborted) {
        setExpanded((prev) => { const n = new Set(prev); n.delete(path); return n; });
        showToast(String(e));
      }
    } finally {
      if (!controller?.signal.aborted) pendingChildren.current.delete(path);
    }
  };

  return (
    <div className="dm-view" data-view="compare">
      <Card title="快照对比" sub="选择任意两次历史快照" right={<span className="dm-sub">{loading ? '计算中…' : payload ? `变化项 ${payload.total_changed.toLocaleString()} 个` : '—'}</span>}>
        <div className="dm-row">
          <label className="dm-field"><span>基准 A</span>
            <select value={a ?? ''} onChange={(e) => setBaseId(Number(e.target.value))}>
              {usable.map((s) => <option key={s.id} value={s.id}>#{s.id} · {fmtTime(s.started_at)} · {statusLabel(s.status)}</option>)}
            </select>
          </label>
          <button className="btn tiny" disabled={!a || !b || a === b} onClick={() => { if (b) setBaseId(b); setB(a); }} title="交换 A / B">⇄ 交换</button>
          <label className="dm-field"><span>对比 B</span>
            <select value={b ?? ''} onChange={(e) => setB(Number(e.target.value))}>
              {usable.map((s) => <option key={s.id} value={s.id}>#{s.id} · {fmtTime(s.started_at)} · {statusLabel(s.status)}</option>)}
            </select>
          </label>
          <span className="grow" style={{ flex: 1 }} />
          <div className="dm-row">{SORTS.map((s) => (
            <button key={s.key} className={'btn tiny' + (sort === s.key ? ' on' : '')} onClick={() => setSort(s.key)}>{s.label}</button>
          ))}</div>
          <div className="dm-row">{FILTERS.map((f) => (
            <button key={f.key} className={'btn tiny' + (filter === f.key ? ' on' : '')} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}</div>
        </div>
      </Card>

      {payload && !payload.reliable && (
        <WarnBar>
          快照 A 为 <b>{statusLabel(payload.status_a)}</b>、B 为 <b>{statusLabel(payload.status_b)}</b>（异常 {payload.error_count_a} / {payload.error_count_b} 条）。
          未扫描到的文件可能显示为新增或删除。差值仅供参考，变化百分比已隐藏。
        </WarnBar>
      )}

      <Card title="目录树变化" sub={payload ? `展示 ${payload.rows.length} 行 · ${payload.truncated ? `另有 ${payload.truncated_count.toLocaleString()} 项未展示` : '全部变化项'}` : '请选择两次不同快照'} right={
        <span className="dm-sub">点击 ▸ 逐级展开到文件</span>
      }>
        <div className="tree-scroll">
          <table className="dm-table tree">
            <thead><tr><th>名称 / 路径</th><th>状态</th><th className="num">A 体积</th><th className="num">B 体积</th><th className="num">变化</th><th className="num">百分比</th><th>操作</th></tr></thead>
            <tbody>
              {visible.map(({ row, depth }) => (
                <tr key={row.path} className={(expanded.has(row.path) ? 'expanded ' : '') + (row.kind === 'removed' ? 'node-deleted' : '')}>
                  <td style={{ paddingLeft: 9 + depth * 16 }}>
                    <span className="node-name">
                      <button className={'twisty' + (row.is_dir ? '' : ' leaf')} onClick={() => void toggle(row.path)} aria-label="展开/收起">▸</button>
                      <span className={'ico ' + (row.is_dir ? 'dir' : 'file')}>{row.is_dir ? '▣' : '▤'}</span>
                      <span title={row.path}>{row.name}</span>
                      {row.context && <span className="dm-sub" style={{ marginLeft: 6 }}>路径</span>}
                    </span>
                  </td>
                  <td><Badge cls={kindBadge(row.kind)}>{kindLabel(row.kind)}</Badge></td>
                  <td className="num">{humanBytes(row.size_a)}</td>
                  <td className="num">{humanBytes(row.size_b)}</td>
                  <td className={'num ' + (row.delta >= 0 ? 'val-up' : 'val-down')}>{fmtDelta(row.delta)}</td>
                  <td className="num">{payload?.reliable ? fmtPct(row.pct) : '—'}</td>
                  <td><button className="btn tiny" disabled={!desktop} onClick={() => onReveal(row.path)}>定位</button></td>
                </tr>
              ))}
              {!visible.length && <tr><td colSpan={7} className="dm-hint">{loading ? '正在计算变化…' : !a || !b || a === b ? '请选择两次不同的快照' : '没有符合条件的变化项'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="dm-hint">目录体积为后序递归汇总值，每个文件只归属直接父目录一次；父目录的变化不会被子目录重复放大。</div>
      </Card>
    </div>
  );
}

// ─────────────────────────────── 扫描设置 ───────────────────────────────

export function SettingsView(props: CommonProps & {
  settings: Settings;
  schedule: ScheduleInfo;
  scheduleReady: boolean;
  dbPath: string;
}) {
  const { settings, schedule, scheduleReady, dbPath, desktop, busy, run } = props;
  const [freq, setFreq] = useState<string>(schedule.frequency);
  const [time, setTime] = useState<string>(schedule.time_hhmm);
  const [weekday, setWeekday] = useState<number>(schedule.weekday);
  const [enabled, setEnabled] = useState<boolean>(schedule.enabled);
  const [max, setMax] = useState<number>(settings.max_snapshots);
  useEffect(() => {
    setFreq(schedule.frequency); setTime(schedule.time_hhmm);
    setWeekday(schedule.weekday); setEnabled(schedule.enabled);
  }, [schedule.frequency, schedule.time_hhmm, schedule.weekday, schedule.enabled]);
  useEffect(() => setMax(settings.max_snapshots), [settings.max_snapshots]);

  return (
    <div className="dm-view" data-view="settings">
      <Card title="自动扫描" sub="Windows 任务计划程序 · 主程序无须常驻" right={
        <Badge cls={schedule.registered ? 'ok' : 'same'}>{!scheduleReady ? '未读取' : schedule.registered ? '已注册' : '未注册'}</Badge>
      }>
        <div className="dm-grid g-2">
          <label className="dm-field"><span>频率</span>
            <select value={freq} onChange={(e) => setFreq(e.target.value)}>
              <option value="daily">每日</option><option value="weekly">每周</option>
            </select>
          </label>
          <label className="dm-field"><span>执行时间</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <label className="dm-field"><span>每周（每周模式生效）</span>
            <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} disabled={freq !== 'weekly'}>
              {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </select>
          </label>
          <label className="dm-field"><span>扫描范围</span><input type="text" value={'C:\\'} readOnly /></label>
        </div>
        <div className="dm-row">
          <label className="dm-lbl"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用自动扫描</label>
          <button className="btn primary" disabled={!desktop || busy || !scheduleReady || !time} onClick={() => void run('dm_set_schedule', { frequency: freq, timeHhmm: time, weekday, enabled }, enabled ? '计划任务已注册' : '计划任务已停用')}>保存并应用</button>
          <button className="btn danger" disabled={!desktop || busy || !scheduleReady} onClick={() => void run('dm_remove_schedule', undefined, '计划任务已移除')}>移除任务</button>
        </div>
        <div className="dm-hint">由 Windows 任务计划程序在指定时间拉起本程序执行「静默扫描 C:\ → 写库 → 退出」，主程序不常驻、不占用后台资源。任务以当前用户身份运行，需保持登录状态。当前状态：{schedule.detail || '—'}</div>
      </Card>

      <Card title="历史清理" sub="只作用于本程序数据库">
        <div className="dm-row">
          <label className="dm-field" style={{ width: 180 }}><span>最大快照数量</span><input type="number" min={2} max={500} value={max} onChange={(e) => setMax(Number(e.target.value))} /></label>
          <button className="btn" disabled={!desktop || busy || !Number.isInteger(max) || max < 2 || max > 500} onClick={() => void run('dm_set_settings', { maxSnapshots: max, autoPrune: settings.auto_prune }, '已保存')}>保存</button>
          <span className="dm-hint">数据库位置：<span className="dm-mono">{dbPath}</span></span>
        </div>
      </Card>

      <Card title="技术与安全约束" sub="v1 固定，不可更改">
        <table className="dm-table">
          <tbody>
            <tr><td>扫描范围</td><td className="dm-mono dm-strong">C:\ 固定（不可更改）</td><td>v1 不支持其它磁盘或自选文件夹</td></tr>
            <tr><td>读取文件内容</td><td><Badge cls="ok">禁止（仅元数据）</Badge></td><td>不读取、不上传任何文件内容</td></tr>
            <tr><td>跟随符号链接 / Junction</td><td><Badge cls="ok">否</Badge></td><td>重解析点跳过并记录数量</td></tr>
            <tr><td>扫描错误</td><td><Badge cls="warn">记录</Badge></td><td>权限不足、文件消失逐条记录</td></tr>
            <tr><td>不完整快照</td><td><Badge cls="warn">警示</Badge></td><td>隐藏百分比，禁止精确变化结论</td></tr>
            <tr><td>自动删除系统文件</td><td><Badge cls="ok">禁止</Badge></td><td>清理只删 SQLite 记录</td></tr>
          </tbody>
        </table>
      </Card>
      <div className="footnote">第一版实现：jwalk 并行遍历 + 深度降序后序汇总 + 批量事务写库 + 两次快照全外连接对比。</div>
    </div>
  );
}
