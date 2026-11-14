//! 全部 Tauri IPC 命令（统一 dm_ 前缀，避免与现有命令重名）。

use crate::diskmon::diff::{self, DiffRow, Filter, SortKey};
use crate::diskmon::sys;
use crate::diskmon::{db, scan, DiskmonState, Progress, ScheduleInfo, Settings, SnapshotRow};
use crate::diskmon::{FolderRankRow, TrendPoint, VolumeInfo};
use serde::Serialize;
use tauri::{AppHandle, State};

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0usize;
    while v >= 1024.0 && i < 4 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.2} {}", UNITS[i])
    }
}

fn conn(state: &State<'_, DiskmonState>) -> Result<rusqlite::Connection, String> {
    db::open(&state.db_path)
}

fn check_pair(a: &SnapshotRow, b: &SnapshotRow) -> Result<(), String> {
    for s in [a, b] {
        if !s.is_usable() {
            return Err(format!("快照 #{} 状态为 {}，不能作为对比依据", s.id, s.status));
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct OverviewPayload {
    pub db_path: String,
    pub volume: VolumeInfo,
    pub settings: Settings,
    pub snapshots: Vec<SnapshotRow>,
    pub latest: Option<SnapshotRow>,
    pub snapshot_count: usize,
    pub net_delta: i64,
    pub trend: Vec<TrendPoint>,
    pub pair: Option<[i64; 2]>,
    pub rankings: Option<diff::OverviewRankings>,
    pub reliable: bool,
    pub status_a: String,
    pub status_b: String,
    pub has_pair: bool,
    /// 首页「文件夹占用空间排行」，基于最新可用快照的目录递归汇总大小。
    pub folders: Vec<FolderRankRow>,
    pub folder_snapshot_id: Option<i64>,
    pub folder_status: String,
    /// 排行占比的分母：该快照统计到的可访问文件总量（不是卷已用空间）。
    pub folder_total_bytes: u64,
}

#[derive(Serialize)]
pub struct ComparePayload {
    pub rows: Vec<DiffRow>,
    pub total_changed: usize,
    pub truncated: bool,
    pub truncated_count: usize,
    pub reliable: bool,
    pub status_a: String,
    pub status_b: String,
    pub error_count_a: u64,
    pub error_count_b: u64,
}

// ─────────────────────────── 状态 / 容量 ───────────────────────────

#[tauri::command]
pub fn dm_scan_progress(state: State<'_, DiskmonState>) -> Result<Progress, String> {
    Ok(state.scan.snapshot())
}

// ─────────────────────────── 扫描 ───────────────────────────

#[tauri::command]
pub fn dm_start_scan(app: AppHandle, state: State<'_, DiskmonState>) -> Result<Progress, String> {
    if !state.scan.try_begin() {
        return Err("已有扫描正在进行，请先取消或等待完成".into());
    }
    let ctl = state.control();
    match scan::start(app, ctl, state.db_path.clone()) {
        Ok(p) => Ok(p),
        Err(e) => {
            state.scan.end();
            Err(e)
        }
    }
}

#[tauri::command]
pub fn dm_cancel_scan(state: State<'_, DiskmonState>) -> Result<Progress, String> {
    let progress = state.scan.snapshot();
    if !progress.running {
        return Err("当前没有正在运行的扫描".into());
    }
    state.scan.cancel.store(true, std::sync::atomic::Ordering::Release);
    Ok(progress)
}

// ─────────────────────────── 快照 ───────────────────────────

#[tauri::command]
pub fn dm_snapshot_errors(state: State<'_, DiskmonState>, id: i64) -> Result<Vec<crate::diskmon::ScanError>, String> {
    db::list_errors(&conn(&state)?, id, 200)
}

#[tauri::command]
pub async fn dm_delete_snapshots(state: State<'_, DiskmonState>, ids: Vec<i64>) -> Result<usize, String> {
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = db::open(&path)?;
        for id in &ids {
            if db::get_snapshot(&c, *id)?.is_some_and(|s| s.status == "running") {
                return Err(format!("快照 #{id} 正在扫描，不能删除"));
            }
        }
        db::delete_snapshots(&mut c, &ids)
    })
    .await
    .map_err(|e| format!("删除快照任务异常：{e}"))?
}

#[tauri::command]
pub fn dm_set_settings(
    state: State<'_, DiskmonState>,
    max_snapshots: u32,
    auto_prune: bool,
) -> Result<Settings, String> {
    let s = Settings {
        max_snapshots: max_snapshots.clamp(2, 500),
        auto_prune,
        ..Default::default()
    };
    db::set_settings(&conn(&state)?, &s)?;
    Ok(s)
}

#[tauri::command]
pub async fn dm_prune(state: State<'_, DiskmonState>) -> Result<usize, String> {
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = db::open(&path)?;
        let s = db::settings(&c)?;
        db::prune(&mut c, s.max_snapshots)
    })
    .await
    .map_err(|e| format!("清理快照任务异常：{e}"))?
}

// ─────────────────────────── 对比 ───────────────────────────

fn get_pair(
    c: &rusqlite::Connection,
    a: i64,
    b: i64,
) -> Result<(SnapshotRow, SnapshotRow), String> {
    if a == b {
        return Err("请选择两次不同的快照".into());
    }
    let sa = db::get_snapshot(c, a)?.ok_or_else(|| format!("快照 #{a} 不存在"))?;
    let sb = db::get_snapshot(c, b)?.ok_or_else(|| format!("快照 #{b} 不存在"))?;
    check_pair(&sa, &sb)?;
    Ok((sa, sb))
}

/// 对比会一次读入两批条目（C 盘可能有百万行），放到阻塞线程池，不占 UI 主线程。
fn compare_inner(
    db_path: &std::path::Path,
    a: i64,
    b: i64,
    sort: Option<String>,
    filter: Option<String>,
    limit: Option<usize>,
) -> Result<ComparePayload, String> {
    let c = db::open(db_path)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let (sa, sb) = get_pair(&tx, a, b)?;
    let ea = db::load_diff_inputs(&tx, a)?;
    let eb = db::load_diff_inputs(&tx, b)?;
    tx.commit().map_err(|e| e.to_string())?;
    let res = diff::diff_snapshots(
        &ea,
        &eb,
        SortKey::parse(sort.as_deref().unwrap_or("growth")),
        Filter::parse(filter.as_deref().unwrap_or("all")),
        limit.unwrap_or(300).clamp(1, 2_000),
    );
    Ok(ComparePayload {
        rows: res.rows,
        total_changed: res.total_changed,
        truncated: res.truncated,
        truncated_count: res.truncated_count,
        reliable: diff::reliable(&sa.status, &sb.status),
        status_a: sa.status.clone(),
        status_b: sb.status.clone(),
        error_count_a: sa.error_count,
        error_count_b: sb.error_count,
    })
}

#[tauri::command]
pub async fn dm_compare(
    state: State<'_, DiskmonState>,
    a: i64,
    b: i64,
    sort: Option<String>,
    filter: Option<String>,
    limit: Option<usize>,
) -> Result<ComparePayload, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || compare_inner(&db_path, a, b, sort, filter, limit))
        .await
        .map_err(|e| format!("对比任务异常：{e}"))?
}

fn children_inner(
    db_path: &std::path::Path,
    a: i64,
    b: i64,
    parent: String,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DiffRow>, String> {
    let c = db::open(db_path)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    get_pair(&tx, a, b)?;
    let ea = db::load_children(&tx, a, &parent)?;
    let eb = db::load_children(&tx, b, &parent)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(diff::children_of(
        &ea,
        &eb,
        &parent,
        SortKey::parse(sort.as_deref().unwrap_or("growth")),
        limit.unwrap_or(500).clamp(1, 2_000),
    ))
}

#[tauri::command]
pub async fn dm_compare_children(
    state: State<'_, DiskmonState>,
    a: i64,
    b: i64,
    parent: String,
    sort: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<DiffRow>, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || children_inner(&db_path, a, b, parent, sort, limit))
        .await
        .map_err(|e| format!("展开目录任务异常：{e}"))?
}

fn overview_inner(db_path: &std::path::Path) -> Result<OverviewPayload, String> {
    let c = db::open(db_path)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let list = db::list_snapshots(&tx)?;
    let trend = db::trend(&tx, 14)?;
    let usable: Vec<_> = list.iter().filter(|s| s.is_usable()).take(2).collect();
    let mut out = OverviewPayload {
        volume: sys::volume_c(),
        db_path: db_path.to_string_lossy().into_owned(),
        settings: db::settings(&tx)?,
        latest: usable.first().map(|s| (*s).clone()),
        snapshots: Vec::new(),
        snapshot_count: list.len(),
        net_delta: 0,
        trend,
        pair: None,
        rankings: None,
        reliable: false,
        status_a: String::new(),
        status_b: String::new(),
        has_pair: false,
        folders: Vec::new(),
        folder_snapshot_id: None,
        folder_status: String::new(),
        folder_total_bytes: 0,
    };
    let mut save_folders = None;
    if let Some(s) = usable.first() {
        out.folders = match db::cached_folders(&tx, s.id)? {
            Some(rows) => rows,
            None => {
                save_folders = Some(s.id);
                db::folder_ranking(&tx, s.id, 12)?
            }
        };
        out.folder_snapshot_id = Some(s.id);
        out.folder_status = s.status.clone();
        out.folder_total_bytes = s.total_bytes;
    }
    // 排行榜口径：B = 最新，A = 上一次（时间正序）。
    if usable.len() == 2 {
        let b = usable[0];
        let a = usable[1];
        out.net_delta = b.total_bytes as i64 - a.total_bytes as i64;
        out.status_a = a.status.clone();
        out.status_b = b.status.clone();
        out.reliable = diff::reliable(&a.status, &b.status);
        out.has_pair = true;
        out.pair = Some([a.id, b.id]);
        out.rankings = db::cached_rankings(&tx, a.id, b.id)?;
    }
    out.snapshots = list;
    tx.commit().map_err(|e| e.to_string())?;
    if let Some(id) = save_folders {
        if let Err(e) = db::save_folders(&c, id, &out.folders) {
            eprintln!("[diskmon] 保存目录排行失败：{e}");
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn dm_overview(state: State<'_, DiskmonState>) -> Result<OverviewPayload, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || overview_inner(&db_path))
        .await
        .map_err(|e| format!("概览任务异常：{e}"))?
}

#[tauri::command]
pub async fn dm_overview_rankings(
    state: State<'_, DiskmonState>,
    a: i64,
    b: i64,
) -> Result<diff::OverviewRankings, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = db::open(&db_path)?;
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        get_pair(&tx, a, b)?;
        if let Some(found) = db::cached_rankings(&tx, a, b)? {
            return Ok(found);
        }
        let ea = db::load_diff_inputs(&tx, a)?;
        let eb = db::load_diff_inputs(&tx, b)?;
        tx.commit().map_err(|e| e.to_string())?;
        let rankings = diff::overview_rankings(&ea, &eb);
        if let Err(e) = db::save_rankings(&c, a, b, &rankings) {
            eprintln!("[diskmon] 保存变化排行失败：{e}");
        }
        Ok(rankings)
    })
    .await
    .map_err(|e| format!("排行任务异常：{e}"))?
}

// ─────────────────────────── 平台能力 ───────────────────────────

#[tauri::command]
pub async fn dm_reveal(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sys::reveal(&path))
        .await
        .map_err(|e| format!("定位任务异常：{e}"))?
}

#[tauri::command]
pub async fn dm_schedule(state: State<'_, DiskmonState>) -> Result<ScheduleInfo, String> {
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = db::schedule(&db::open(&path)?)?;
        if let Ok((registered, detail)) = sys::query_schedule() {
            s.registered = registered;
            s.detail = detail;
        }
        Ok(s)
    })
    .await
    .map_err(|e| format!("读取计划任务异常：{e}"))?
}

#[tauri::command]
pub async fn dm_set_schedule(
    state: State<'_, DiskmonState>,
    frequency: String,
    time_hhmm: String,
    weekday: u8,
    enabled: bool,
) -> Result<ScheduleInfo, String> {
    let freq = if frequency == "weekly" { "weekly" } else { "daily" };
    let parts: Vec<&str> = time_hhmm.split(':').collect();
    let ok_time = parts.len() == 2
        && parts[0].parse::<u32>().map(|h| h < 24).unwrap_or(false)
        && parts[1].parse::<u32>().map(|m| m < 60).unwrap_or(false)
        && parts[0].len() == 2
        && parts[1].len() == 2;
    if !ok_time {
        return Err("执行时间需为 HH:MM（如 09:00）".into());
    }
    let mut s = ScheduleInfo {
        enabled,
        frequency: freq.into(),
        time_hhmm: time_hhmm.clone(),
        weekday: weekday.clamp(1, 7),
        ..Default::default()
    };
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            sys::register_schedule(&s)?;
        } else {
            sys::remove_schedule()?;
        }
        db::save_schedule(&db::open(&path)?, &s, crate::diskmon::now_secs())?;
        s.registered = enabled;
        s.detail = if enabled {
            format!("已注册：{} {} {}", freq, time_hhmm, if freq == "weekly" { "每周" } else { "每日" })
        } else {
            "已停用".into()
        };
        Ok(s)
    })
    .await
    .map_err(|e| format!("保存计划任务异常：{e}"))?
}

#[tauri::command]
pub async fn dm_remove_schedule(state: State<'_, DiskmonState>) -> Result<ScheduleInfo, String> {
    let path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = db::open(&path)?;
        sys::remove_schedule()?;
        let mut s = db::schedule(&c)?;
        s.enabled = false;
        s.registered = false;
        s.detail = "已移除计划任务".into();
        db::save_schedule(&c, &s, crate::diskmon::now_secs())?;
        Ok(s)
    })
    .await
    .map_err(|e| format!("移除计划任务异常：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::human_bytes;

    #[test]
    fn human_bytes_units() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.00 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.00 MB");
        assert!(human_bytes(10 * 1024 * 1024 * 1024).ends_with("GB"));
    }
}
