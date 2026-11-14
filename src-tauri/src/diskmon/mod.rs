//! 磁盘空间变化监测（v1：监测目标固定为 C:\）。
//!
//! 分层：
//!   aggregate.rs —— 纯函数：深度降序后序汇总，保证每个文件只被计入一次
//!   diff.rs      —— 纯函数：两次快照全外连接、状态判定、排序与祖先链补齐
//!   db.rs        —— SQLite 表结构、批量事务写入、快照/设置读写
//!   scan.rs      —— jwalk 并行遍历 + 取消 + 进度事件（只取元数据）
//!   sys.rs       —— 仅 C 盘卷容量、资源管理器定位、Windows 任务计划程序
//!   commands.rs  —— 全部 Tauri IPC 命令
//!
//! 安全约束：扫描过程绝不打开/读取文件内容；不跟随符号链接、Junction 等重解析点；
//! 不自动删除任何磁盘文件（所有删除都只作用于本程序自己的 SQLite 记录）。

pub mod aggregate;
pub mod commands;
pub mod db;
pub mod diff;
pub mod scan;
pub mod sys;

#[cfg(test)]
mod e2e;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

/// v1 唯一的扫描根目录。常量硬编码，界面不提供任何修改入口。
pub const ROOT: &str = "C:\\";
pub const DB_FILE: &str = "diskmon.sqlite3";
/// 每批写入的条目数（一个事务一批）。
pub const BATCH_SIZE: usize = 2_000;
/// 单次扫描最多保留的错误明细条数，超出只累计计数，避免权限错误淹没数据库。
pub const MAX_ERROR_ROWS: usize = 2_000;
pub const SCHEDULE_TASK: &str = "PudiTools DiskMonitor C";

// ────────────────────────────── 数据结构 ──────────────────────────────

/// 扫描得到的原始条目：仅元数据，绝不含文件内容。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawEntry {
    pub path: String,
    pub parent: Option<String>,
    pub name: String,
    pub is_dir: bool,
    /// 文件自身逻辑大小；目录恒为 0（汇总值由 aggregate 计算）。
    pub own_bytes: u64,
    pub ext: Option<String>,
    pub mtime: Option<i64>,
    pub is_reparse: bool,
    pub depth: usize,
}

/// 入库条目。目录的 size_bytes 是后序汇总后的递归大小。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredEntry {
    pub path: String,
    pub parent: Option<String>,
    pub name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub own_bytes: u64,
    pub ext: Option<String>,
    pub mtime: Option<i64>,
    pub is_reparse: bool,
    pub depth: usize,
}

/// 首页「文件夹占用空间排行」的一行。size_bytes 是后序汇总后的递归大小
/// （含所有子孙目录），只由元数据计算，不读取文件内容。
/// 目录的 own_bytes 在聚合后恒为 0，故不暴露该字段，避免被误读成「直属文件之和」。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolderRankRow {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub depth: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanError {
    pub path: String,
    pub kind: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotRow {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub root_path: String,
    /// running | complete | partial | cancelled | failed
    pub status: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub error_count: u64,
    pub reparse_count: u64,
    pub volume_total: u64,
    pub volume_free: u64,
}

impl SnapshotRow {
    pub fn is_usable(&self) -> bool {
        matches!(self.status.as_str(), "complete" | "partial")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VolumeInfo {
    pub total: u64,
    pub free: u64,
    pub used: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub max_snapshots: u32,
    pub auto_prune: bool,
    /// 展示用：扫描安全选项全部为固定值，界面只读。
    pub follow_reparse: bool,
    pub read_content: bool,
    pub root_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_snapshots: 30,
            auto_prune: true,
            follow_reparse: false,
            read_content: false,
            root_path: ROOT.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleInfo {
    pub enabled: bool,
    /// daily | weekly
    pub frequency: String,
    /// HH:MM
    pub time_hhmm: String,
    /// 1=周一 … 7=周日
    pub weekday: u8,
    pub task_name: String,
    pub registered: bool,
    pub detail: String,
}

impl Default for ScheduleInfo {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: "daily".into(),
            time_hhmm: "09:00".into(),
            weekday: 1,
            task_name: SCHEDULE_TASK.to_string(),
            registered: false,
            detail: String::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Progress {
    pub running: bool,
    pub snapshot_id: Option<i64>,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub errors: u64,
    pub reparse: u64,
    pub current_path: String,
    pub started_at: i64,
    /// 遍历阶段无法预知总量，这里给的是饱和估算值，界面需标注「估算」。
    pub percent: f64,
    /// idle | scanning | aggregating | writing | done | cancelled | failed
    pub phase: String,
    pub message: String,
}

impl Progress {
    pub fn idle() -> Self {
        Self { phase: "idle".into(), ..Default::default() }
    }
}

// ────────────────────────────── 运行状态 ──────────────────────────────

pub struct ScanControl {
    pub cancel: Arc<AtomicBool>,
    pub progress: Arc<Mutex<Progress>>,
    running: Arc<AtomicBool>,
}

impl ScanControl {
    /// 抢占扫描权；已有扫描在跑时返回 false。
    pub fn try_begin(&self) -> bool {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub fn end(&self) {
        self.running.store(false, Ordering::Release);
    }
    pub fn snapshot(&self) -> Progress {
        self.progress.lock().map(|p| p.clone()).unwrap_or_else(|_| Progress::idle())
    }
}

pub struct DiskmonState {
    pub db_path: PathBuf,
    pub scan: ScanControl,
}

impl DiskmonState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            scan: ScanControl {
                cancel: Arc::new(AtomicBool::new(false)),
                progress: Arc::new(Mutex::new(Progress::idle())),
                running: Arc::new(AtomicBool::new(false)),
            },
        }
    }
    pub fn control(&self) -> ControlHandle {
        ControlHandle {
            cancel: self.scan.cancel.clone(),
            progress: self.scan.progress.clone(),
            running: self.scan.running.clone(),
        }
    }
}

/// 可安全 move 进后台线程的扫描控制句柄。
#[derive(Clone)]
pub struct ControlHandle {
    pub cancel: Arc<AtomicBool>,
    pub progress: Arc<Mutex<Progress>>,
    pub running: Arc<AtomicBool>,
}

impl ControlHandle {
    pub fn set(&self, p: Progress) {
        if let Ok(mut g) = self.progress.lock() {
            *g = p;
        }
    }
    pub fn update<F: FnOnce(&mut Progress)>(&self, f: F) {
        if let Ok(mut g) = self.progress.lock() {
            f(&mut g);
        }
    }
    pub fn finish(&self) {
        self.running.store(false, Ordering::Release);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrendPoint {
    pub id: i64,
    pub started_at: i64,
    pub total_bytes: u64,
    pub status: String,
    pub file_count: u64,
}

/// Unix 秒（不引入 chrono，格式化交给前端）。
pub fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 路径规范化：统一盘符大写、去掉 `\\?\` 前缀、统一分隔符。
/// 快照对比靠 path 做全外连接，必须先规范化，否则同一路径会因为大小写/前缀
/// 被当成两个节点。
pub fn normalize_path(p: &std::path::Path) -> String {
    let mut s = p.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\") {
        s = rest.to_string();
    }
    // 盘符大写（只对 "x:\" 形态动手）
    let bytes = s.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        s.replace_range(0..1, &(bytes[0].to_ascii_uppercase() as char).to_string());
    }
    // 去掉结尾多余反斜杠，根目录 "C:\" 保留
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

pub fn legacy_path(path: String) -> String {
    if path == "67:" {
        return ROOT.into();
    }
    match path.strip_prefix("67:\\") {
        Some(tail) => format!("{ROOT}{tail}"),
        None => path,
    }
}
