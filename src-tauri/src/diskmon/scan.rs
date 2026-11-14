//! C 盘扫描：jwalk 并行遍历 → 后序汇总 → 批量写库。
//!
//! * 全程只调用 `symlink_metadata`，绝不打开或读取文件内容；
//! * `follow_links(false)` + 重解析点判定，符号链接 / Junction 不进入、不计数；
//! * 遍历在后台线程，进度通过 Tauri 事件推送，前端不轮询；
//! * 取消用 AtomicBool，每个条目检查一次，事务按批提交，取消不留半成品数据；
//! * 权限不足 / 文件消失按条记录，快照标为 partial，禁止据此给精确结论。

use crate::diskmon::aggregate::{depth_of, into_stored, parent_of, root_total};
use crate::diskmon::db;
use crate::diskmon::sys;
use crate::diskmon::{
    now_secs, normalize_path, ControlHandle, Progress, RawEntry, ScanError, BATCH_SIZE,
    MAX_ERROR_ROWS, ROOT,
};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const EVT_PROGRESS: &str = "diskmon://progress";
pub const EVT_FINISHED: &str = "diskmon://finished";

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
type ScanWalkState = ((), Option<jwalk::Result<std::fs::Metadata>>);

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata, is_symlink: bool) -> bool {
    use std::os::windows::fs::MetadataExt;
    (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || is_symlink
}
#[cfg(not(windows))]
fn is_reparse(_meta: &std::fs::Metadata, is_symlink: bool) -> bool {
    is_symlink
}

fn emit(app: &AppHandle, p: &Progress) {
    let _ = app.emit(EVT_PROGRESS, p.clone());
}

fn add_error(errors: &mut Vec<ScanError>, count: &mut u64, path: String, kind: &str, msg: String) {
    *count += 1;
    if errors.len() < MAX_ERROR_ROWS {
        errors.push(ScanError { path, kind: kind.into(), message: msg });
    }
}

pub fn try_lock(db_path: &Path) -> Result<Option<File>, String> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(db_path.with_extension("scan.lock"))
        .map_err(|e| format!("无法打开扫描锁：{e}"))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(format!("无法锁定扫描：{e}")),
    }
}

fn record_walk_error(err: &jwalk::Error, errors: &mut Vec<ScanError>, count: &mut u64) {
    let path = err.path().map(normalize_path).unwrap_or_else(|| ROOT.into());
    let kind = match err.io_error().map(|e| e.kind()) {
        Some(ErrorKind::PermissionDenied) => "permission",
        Some(ErrorKind::NotFound) => "disappeared",
        _ => "io",
    };
    add_error(errors, count, path, kind, err.to_string());
}

/// 供命令调用：抢占扫描权后立刻返回，实际工作在后台线程。
pub fn start(app: AppHandle, ctl: ControlHandle, db_path: PathBuf) -> Result<Progress, String> {
    let lock = try_lock(&db_path)?.ok_or_else(|| "已有扫描正在进行（可能由计划任务启动）".to_string())?;
    let started = now_secs();
    let mut p = Progress {
        running: true,
        started_at: started,
        phase: "scanning".into(),
        message: "正在准备扫描 C:\\…".into(),
        ..Default::default()
    };
    ctl.cancel.store(false, Ordering::Release);
    ctl.set(p.clone());
    let ctl2 = ctl.clone();
    let spawned = std::thread::Builder::new()
        .name("diskmon-scan".into())
        .spawn(move || {
            let result = run(&app, &ctl2, &db_path, lock);
            if let Err(err) = result {
                ctl2.update(|p| {
                    p.running = false;
                    p.phase = "failed".into();
                    p.message = err.clone();
                });
                ctl2.finish();
                let progress = ctl2.progress.lock().ok().map(|p| p.clone());
                if let Some(p) = progress {
                    emit(&app, &p);
                }
                let _ = app.emit(EVT_FINISHED, serde_json::json!({ "ok": false, "error": err }));
            }
        });
    if let Err(err) = spawned {
        let msg = format!("无法启动扫描线程：{err}");
        ctl.update(|p| {
            p.running = false;
            p.phase = "failed".into();
            p.message = msg.clone();
        });
        return Err(msg);
    }
    p.message = "扫描已启动".into();
    Ok(p)
}

/// 计划任务的静默扫描：同步执行完就退出进程，不创建常驻窗口交互。
pub fn run_silent(app: &AppHandle, ctl: &ControlHandle, db_path: &Path) -> Result<(), String> {
    ctl.cancel.store(false, Ordering::Release);
    if let Some(lock) = try_lock(db_path)? {
        run(app, ctl, db_path, lock)?;
    }
    Ok(())
}

fn run(app: &AppHandle, ctl: &ControlHandle, db_path: &Path, lock: File) -> Result<(), String> {
    let started = now_secs();
    let vol = sys::volume_c();
    let mut conn = db::open(db_path)?;
    db::recover_interrupted(&mut conn)?;
    let id = db::create_snapshot(&conn, started, vol.total, vol.free)?;
    let result = collect_scan(app, ctl, &mut conn, id, started);
    let (p, status) = match result {
        Ok(result) => result,
        Err(err) => {
            if let Err(cleanup) = db::discard_snapshot(&mut conn, id, "failed", 0, 0) {
                return Err(format!("{err}；清理失败的快照：{cleanup}"));
            }
            return Err(err);
        }
    };
    drop(conn);
    drop(lock);
    ctl.set(p.clone());
    ctl.finish();
    emit(app, &p);
    let _ = app.emit(
        EVT_FINISHED,
        serde_json::json!({ "ok": status != "cancelled", "snapshot_id": id, "status": status }),
    );
    Ok(())
}

fn collect_scan(
    app: &AppHandle,
    ctl: &ControlHandle,
    conn: &mut rusqlite::Connection,
    id: i64,
    started: i64,
) -> Result<(Progress, &'static str), String> {
    let mut p = Progress {
        running: true,
        snapshot_id: Some(id),
        started_at: started,
        phase: "scanning".into(),
        current_path: ROOT.into(),
        message: "正在遍历 C:\\（仅元数据）…".into(),
        ..Default::default()
    };
    ctl.set(p.clone());
    emit(app, &p);

    let mut raw: Vec<RawEntry> = Vec::with_capacity(200_000);
    let mut errors: Vec<ScanError> = Vec::new();
    let mut error_count = 0u64;
    let mut reparse_count = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;
    let mut bytes = 0u64;
    let mut cancelled = false;
    let mut last_emit = Instant::now();

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let walker = jwalk::WalkDirGeneric::<ScanWalkState>::new(ROOT)
        .follow_links(false)
        .skip_hidden(false)
        .process_read_dir(|_, _, _, entries| {
            for entry in entries.iter_mut().filter_map(|e| e.as_mut().ok()) {
                if entry.read_children_path.is_some() {
                    let metadata = entry.metadata();
                    if metadata.as_ref().map_or(true, |m| is_reparse(m, false)) {
                        entry.read_children_path = None;
                    }
                    entry.client_state = Some(metadata);
                }
            }
        })
        .parallelism(jwalk::Parallelism::RayonNewPool(threads));

    for item in walker.into_iter() {
        if ctl.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let mut de = match item {
            Ok(d) => d,
            Err(err) => {
                record_walk_error(&err, &mut errors, &mut error_count);
                continue;
            }
        };
        if let Some(err) = &de.read_children_error {
            record_walk_error(err, &mut errors, &mut error_count);
        }

        let path_buf = de.path();
        let path = normalize_path(&path_buf);
        let meta = match de.client_state.take().unwrap_or_else(|| de.metadata()) {
            Ok(m) => m,
            Err(err) => {
                record_walk_error(&err, &mut errors, &mut error_count);
                continue;
            }
        };
        let ft = de.file_type();
        let reparse = is_reparse(&meta, ft.is_symlink());
        let is_dir = ft.is_dir();
        if reparse {
            reparse_count += 1;
            continue;
        }
        let own = if is_dir { 0 } else { meta.len() };
        let name = de.file_name().to_string_lossy().to_string();
        let ext = if is_dir {
            None
        } else {
            path_buf
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .filter(|x| !x.is_empty())
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        raw.push(RawEntry {
            parent: parent_of(&path),
            name,
            is_dir,
            own_bytes: own,
            ext,
            mtime,
            is_reparse: reparse,
            depth: depth_of(&path),
            path: path.clone(),
        });
        if is_dir {
            dirs += 1;
        } else {
            files += 1;
        }
        bytes += own;

        let n = files + dirs;
        if n % 4_000 == 0 || last_emit.elapsed().as_millis() >= 250 {
            // 无法预知 C 盘总量，遍历阶段用饱和曲线给「估算」进度（上限 82%）
            let est = 1.0 - (-(n as f64) / 250_000.0).exp();
            p.percent = (est * 82.0).min(82.0);
            p.files = files;
            p.dirs = dirs;
            p.bytes = bytes;
            p.errors = error_count;
            p.reparse = reparse_count;
            p.current_path = parent_of(&path).unwrap_or_else(|| ROOT.to_string());
            p.message = format!("已扫描 {n} 项 · 跳过 {reparse_count} 个重解析点");
            ctl.set(p.clone());
            emit(app, &p);
            last_emit = Instant::now();
        }
    }

    cancelled |= ctl.cancel.load(Ordering::Acquire);
    if !cancelled && files + dirs == 0 {
        let detail = errors.first().map(|error| error.message.as_str()).unwrap_or("未读到 C 盘根目录");
        return Err(format!("无法扫描 C 盘：{detail}"));
    }
    if !cancelled {
        p.phase = "aggregating".into();
        p.message = "正在按目录层级汇总大小…".into();
        p.percent = 84.0;
        ctl.set(p.clone());
        emit(app, &p);
    }

    let stored = if cancelled { Vec::new() } else { into_stored(raw) };
    let total_bytes = if stored.is_empty() { 0 } else { root_total(&stored) };
    let total_rows = stored.len();
    let mut written = 0usize;

    if !cancelled {
        p.phase = "writing".into();
        p.message = "正在批量写入快照…".into();
        ctl.set(p.clone());
        emit(app, &p);
        for chunk in stored.chunks(BATCH_SIZE) {
            if ctl.cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            db::insert_batch(conn, id, chunk)?;
            written += chunk.len();
            p.percent = 84.0 + 15.0 * (written as f64 / total_rows.max(1) as f64);
            p.message = format!("已写入 {written} / {total_rows} 条");
            ctl.set(p.clone());
            emit(app, &p);
        }
    }

    cancelled |= ctl.cancel.load(Ordering::Acquire);
    if !cancelled {
        db::insert_errors(conn, id, &errors)?;
        cancelled = ctl.cancel.load(Ordering::Acquire);
    }
    let status = if cancelled {
        db::discard_snapshot(conn, id, "cancelled", error_count, reparse_count)?;
        "cancelled"
    } else {
        let status = if error_count > 0 { "partial" } else { "complete" };
        db::finish_snapshot(
            conn,
            id,
            status,
            total_bytes,
            files,
            dirs,
            error_count,
            reparse_count,
            now_secs(),
        )?;
        status
    };

    let cleanup = db::settings(conn).and_then(|s| {
        if s.auto_prune { db::prune(conn, s.max_snapshots).map(|_| ()) } else { Ok(()) }
    });

    p.running = false;
    if !cancelled {
        p.percent = 100.0;
    }
    p.phase = if cancelled { "cancelled" } else { "done" }.into();
    p.files = files;
    p.dirs = dirs;
    p.bytes = bytes;
    p.errors = error_count;
    p.reparse = reparse_count;
    p.message = if cancelled {
        "扫描已取消，本次结果不参与对比".into()
    } else {
        format!(
            "扫描完成 · 快照 #{id} · {files} 个文件 · {} · {error_count} 条异常",
            crate::diskmon::commands::human_bytes(total_bytes)
        )
    };
    if let Err(err) = cleanup {
        p.message.push_str(&format!(" · 自动清理失败：{err}"));
    }
    Ok((p, status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_lock_is_exclusive_until_released() {
        let db_path = std::env::temp_dir().join(format!("pudi-diskmon-test-{}.sqlite3", std::process::id()));
        let first = try_lock(&db_path).unwrap().unwrap();
        assert!(try_lock(&db_path).unwrap().is_none());
        drop(first);
        assert!(try_lock(&db_path).unwrap().is_some());
        std::fs::remove_file(db_path.with_extension("scan.lock")).unwrap();
    }
}
