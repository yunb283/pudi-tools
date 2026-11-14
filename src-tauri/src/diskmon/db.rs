//! SQLite 持久化：WAL、快照与变化排行缓存、批量事务写入。
//!
//! 所有删除操作都只作用于本程序自己的数据库记录，绝不触碰磁盘上的任何文件。

use crate::diskmon::diff::{DiffInput, OverviewRankings};
use crate::diskmon::{
    FolderRankRow, ScanError, ScheduleInfo, Settings, SnapshotRow, StoredEntry, TrendPoint, ROOT,
    SCHEDULE_TASK,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  root_path     TEXT    NOT NULL DEFAULT 'C:\',
  status        TEXT    NOT NULL DEFAULT 'running',
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  dir_count     INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  reparse_count INTEGER NOT NULL DEFAULT 0,
  volume_total  INTEGER NOT NULL DEFAULT 0,
  volume_free   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  snapshot_id INTEGER NOT NULL,
  path        TEXT    NOT NULL,
  parent_path TEXT,
  name        TEXT    NOT NULL,
  is_dir      INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  own_bytes   INTEGER NOT NULL,
  ext         TEXT,
  mtime       INTEGER,
  is_reparse  INTEGER NOT NULL DEFAULT 0,
  depth       INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, path),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(snapshot_id, parent_path);

CREATE TABLE IF NOT EXISTS overview_rankings (
  snapshot_a INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  snapshot_b INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  PRIMARY KEY (snapshot_a, snapshot_b)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS folder_rankings (
  snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT,
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_errors_snap ON scan_errors(snapshot_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  frequency  TEXT    NOT NULL DEFAULT 'daily',
  time_hhmm  TEXT    NOT NULL DEFAULT '09:00',
  weekday    INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 0,
  task_name  TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

fn e(msg: impl std::fmt::Display) -> String {
    format!("数据库操作失败：{msg}")
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|x| e(format!("无法打开 {}: {x}", path.display())))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;",
    )
    .map_err(|x| e(x))?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(DDL).map_err(|x| e(x))?;
    conn.execute(
        "INSERT OR IGNORE INTO schedules (id, task_name, updated_at) VALUES (1, ?1, 0)",
        params![SCHEDULE_TASK],
    )
    .map_err(|x| e(x))?;
    Ok(())
}

/// 仅在持有跨进程扫描锁时调用。
pub fn recover_interrupted(conn: &mut Connection) -> Result<(), String> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM snapshots WHERE status='running'").map_err(e)?;
        stmt.query_map([], |r| r.get(0)).map_err(e)?.collect::<Result<_, _>>().map_err(e)?
    };
    for id in ids {
        discard_snapshot(conn, id, "cancelled", 0, 0)?;
    }
    Ok(())
}

pub fn discard_snapshot(
    conn: &mut Connection,
    id: i64,
    status: &str,
    errors: u64,
    reparse: u64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(e)?;
    tx.execute("DELETE FROM entries WHERE snapshot_id=?1", [id]).map_err(e)?;
    tx.execute("DELETE FROM scan_errors WHERE snapshot_id=?1", [id]).map_err(e)?;
    finish_snapshot(&tx, id, status, 0, 0, 0, errors, reparse, super::now_secs())?;
    tx.commit().map_err(e)
}

pub fn create_snapshot(
    conn: &Connection,
    started_at: i64,
    volume_total: u64,
    volume_free: u64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO snapshots (started_at, root_path, status, volume_total, volume_free)
         VALUES (?1, ?2, 'running', ?3, ?4)",
        params![started_at, ROOT, volume_total as i64, volume_free as i64],
    )
    .map_err(|x| e(x))?;
    Ok(conn.last_insert_rowid())
}

/// 批量写入：每 BATCH_SIZE 条一个事务，避免每条都 commit。
pub fn insert_batch(
    conn: &mut Connection,
    snapshot_id: i64,
    rows: &[StoredEntry],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|x| e(x))?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO entries
                 (snapshot_id, path, parent_path, name, is_dir, size_bytes, own_bytes, ext, mtime, is_reparse, depth)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            )
            .map_err(|x| e(x))?;
        for r in rows {
            stmt.execute(params![
                snapshot_id,
                r.path,
                r.parent,
                r.name,
                r.is_dir as i32,
                r.size_bytes as i64,
                r.own_bytes as i64,
                r.ext,
                r.mtime,
                r.is_reparse as i32,
                r.depth as i64,
            ])
            .map_err(|x| e(format!("写入 {} 时：{x}", r.path)))?;
        }
    }
    tx.commit().map_err(|x| e(x))
}

pub fn insert_errors(conn: &mut Connection, snapshot_id: i64, errors: &[ScanError]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|x| e(x))?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO scan_errors (snapshot_id, path, kind, message) VALUES (?1,?2,?3,?4)",
            )
            .map_err(|x| e(x))?;
        for er in errors {
            stmt.execute(params![snapshot_id, er.path, er.kind, er.message])
                .map_err(|x| e(x))?;
        }
    }
    tx.commit().map_err(|x| e(x))
}

pub fn finish_snapshot(
    conn: &Connection,
    id: i64,
    status: &str,
    total_bytes: u64,
    files: u64,
    dirs: u64,
    errors: u64,
    reparse: u64,
    finished_at: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE snapshots SET status=?2, total_bytes=?3, file_count=?4, dir_count=?5,
         error_count=?6, reparse_count=?7, finished_at=?8 WHERE id=?1",
        params![
            id,
            status,
            total_bytes as i64,
            files as i64,
            dirs as i64,
            errors as i64,
            reparse as i64,
            finished_at
        ],
    )
    .map_err(|x| e(x))?;
    Ok(())
}

fn row_to_snapshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotRow> {
    Ok(SnapshotRow {
        id: r.get(0)?,
        started_at: r.get(1)?,
        finished_at: r.get(2)?,
        root_path: r.get(3)?,
        status: r.get(4)?,
        total_bytes: r.get::<_, i64>(5)? as u64,
        file_count: r.get::<_, i64>(6)? as u64,
        dir_count: r.get::<_, i64>(7)? as u64,
        error_count: r.get::<_, i64>(8)? as u64,
        reparse_count: r.get::<_, i64>(9)? as u64,
        volume_total: r.get::<_, i64>(10)? as u64,
        volume_free: r.get::<_, i64>(11)? as u64,
    })
}

const SNAP_COLS: &str = "id, started_at, finished_at, root_path, status, total_bytes,
 file_count, dir_count, error_count, reparse_count, volume_total, volume_free";

pub fn list_snapshots(conn: &Connection) -> Result<Vec<SnapshotRow>, String> {
    let sql = format!("SELECT {SNAP_COLS} FROM snapshots ORDER BY id DESC");
    let mut stmt = conn.prepare(&sql).map_err(|x| e(x))?;
    let rows = stmt
        .query_map([], row_to_snapshot)
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    Ok(rows)
}

pub fn get_snapshot(conn: &Connection, id: i64) -> Result<Option<SnapshotRow>, String> {
    let sql = format!("SELECT {SNAP_COLS} FROM snapshots WHERE id=?1");
    conn.query_row(&sql, params![id], row_to_snapshot)
        .optional()
        .map_err(|x| e(x))
}

pub fn list_errors(conn: &Connection, id: i64, limit: usize) -> Result<Vec<ScanError>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path, kind, message FROM scan_errors WHERE snapshot_id=?1 ORDER BY id LIMIT ?2",
        )
        .map_err(|x| e(x))?;
    let rows = stmt
        .query_map(params![id, limit as i64], |r| {
            Ok(ScanError {
                path: super::legacy_path(r.get(0)?),
                kind: r.get(1)?,
                message: r.get(2)?,
            })
        })
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    Ok(rows)
}

/// 只删本程序的快照记录（级联删 entries / scan_errors），不碰磁盘文件。
pub fn delete_snapshots(conn: &mut Connection, ids: &[i64]) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|x| e(x))?;
    let mut n = 0usize;
    {
        let mut stmt = tx
            .prepare_cached("DELETE FROM snapshots WHERE id=?1")
            .map_err(|x| e(x))?;
        for id in ids {
            n += stmt.execute(params![id]).map_err(|x| e(x))?;
        }
    }
    tx.commit().map_err(|x| e(x))?;
    Ok(n)
}

/// 按最大数量保留最新 N 个（跳过正在跑的），返回删除条数。
pub fn prune(conn: &mut Connection, max: u32) -> Result<usize, String> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM snapshots WHERE status != 'running' ORDER BY id DESC LIMIT -1 OFFSET ?1")
            .map_err(|x| e(x))?;
        stmt.query_map(params![max as i64], |r| r.get::<_, i64>(0))
            .map_err(|x| e(x))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|x| e(x))?
    };
    if ids.is_empty() {
        return Ok(0);
    }
    delete_snapshots(conn, &ids)
}

pub fn settings(conn: &Connection) -> Result<Settings, String> {
    let mut s = Settings::default();
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|x| e(x))?;
    let kv = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    for (k, v) in kv {
        match k.as_str() {
            "max_snapshots" => s.max_snapshots = v.parse().unwrap_or(s.max_snapshots).clamp(2, 500),
            "auto_prune" => s.auto_prune = v == "1",
            _ => {}
        }
    }
    Ok(s)
}

pub fn set_settings(conn: &Connection, s: &Settings) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value)
         VALUES ('max_snapshots', ?1), ('auto_prune', ?2)",
        params![s.max_snapshots.to_string(), if s.auto_prune { "1" } else { "0" }],
    )
    .map_err(|x| e(x))?;
    Ok(())
}

pub fn trend(conn: &Connection, limit: usize) -> Result<Vec<TrendPoint>, String> {
    let sql = "SELECT id, started_at, total_bytes, status, file_count FROM snapshots
               WHERE status IN ('complete', 'partial') ORDER BY started_at DESC, id DESC LIMIT ?1";
    let mut stmt = conn.prepare(sql).map_err(|x| e(x))?;
    let mut all = stmt
        .query_map(params![limit.min(200) as i64], |r| {
            Ok(TrendPoint {
                id: r.get(0)?,
                started_at: r.get(1)?,
                total_bytes: r.get::<_, i64>(2)? as u64,
                status: r.get(3)?,
                file_count: r.get::<_, i64>(4)? as u64,
            })
        })
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    all.reverse();
    Ok(all)
}

fn row_to_diff(r: &rusqlite::Row<'_>) -> rusqlite::Result<DiffInput> {
    let path = super::legacy_path(r.get(0)?);
    let parent = r.get::<_, Option<String>>(1)?.map(super::legacy_path);
    Ok(DiffInput {
        parent: if path == ROOT { None } else { parent },
        path,
        name: super::legacy_path(r.get(2)?),
        is_dir: r.get::<_, i32>(3)? != 0,
        size_bytes: r.get::<_, i64>(4)? as u64,
        ext: r.get(5)?,
        depth: r.get::<_, i64>(6)? as usize,
    })
}

pub fn load_diff_inputs(conn: &Connection, id: i64) -> Result<Vec<DiffInput>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path, parent_path, name, is_dir, size_bytes, ext, depth
             FROM entries WHERE snapshot_id=?1",
        )
        .map_err(|x| e(x))?;
    let rows = stmt
        .query_map(params![id], row_to_diff)
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    Ok(rows)
}

pub fn load_children(conn: &Connection, id: i64, parent: &str) -> Result<Vec<DiffInput>, String> {
    let legacy_parent = parent.strip_prefix(ROOT).map(|tail| {
        if tail.is_empty() { "67:".into() } else { format!("67:\\{tail}") }
    });
    conn.prepare(
        "SELECT path, parent_path, name, is_dir, size_bytes, ext, depth
         FROM entries WHERE snapshot_id=?1 AND parent_path IN (?2, ?3)",
    )
    .map_err(e)?
    .query_map(params![id, parent, legacy_parent], row_to_diff)
    .map_err(e)?
    .filter(|row| !matches!(row, Ok(entry) if entry.path == ROOT))
    .collect::<Result<_, _>>()
    .map_err(e)
}

pub fn cached_rankings(conn: &Connection, a: i64, b: i64) -> Result<Option<OverviewRankings>, String> {
    let payload: Option<String> = conn.query_row(
        "SELECT payload FROM overview_rankings WHERE snapshot_a=?1 AND snapshot_b=?2",
        params![a, b],
        |r| r.get(0),
    ).optional().map_err(e)?;
    Ok(payload.and_then(|json| serde_json::from_str(&json).ok()))
}

pub fn save_rankings(conn: &Connection, a: i64, b: i64, rankings: &OverviewRankings) -> Result<(), String> {
    let payload = serde_json::to_string(rankings).map_err(e)?;
    conn.execute(
        "INSERT OR REPLACE INTO overview_rankings (snapshot_a, snapshot_b, payload)
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM snapshots WHERE id=?1)
           AND EXISTS (SELECT 1 FROM snapshots WHERE id=?2)",
        params![a, b, payload],
    ).map_err(e)?;
    Ok(())
}

pub fn cached_folders(conn: &Connection, id: i64) -> Result<Option<Vec<FolderRankRow>>, String> {
    let payload: Option<String> = conn.query_row(
        "SELECT payload FROM folder_rankings WHERE snapshot_id=?1", [id], |r| r.get(0),
    ).optional().map_err(e)?;
    Ok(payload.and_then(|json| serde_json::from_str(&json).ok()))
}

pub fn save_folders(conn: &Connection, id: i64, folders: &[FolderRankRow]) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO folder_rankings (snapshot_id, payload)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM snapshots WHERE id=?1)",
        params![id, serde_json::to_string(folders).map_err(e)?],
    ).map_err(e)?;
    Ok(())
}

/// 首页文件夹占用排行：取某次快照中「递归汇总大小」最大的 N 个目录。
///
/// 口径说明：
/// - 只取 `is_dir=1`，大小来自 aggregate 的后序汇总（含所有子孙），每个文件只计一次；
/// - 排除根目录 C:\（depth=0，它恒等于快照总量，占据榜首没有信息量）；
///   用 depth 而非路径字符串比较，避免大小写 / 斜杠形态差异导致漏排除；
/// - 排除重解析点（默认不跟随，其 size_bytes 无意义）；
/// - 排序完全交给 SQLite，前端拿到即是有序结果，不重复计数、不二次聚合。
pub fn folder_ranking(
    conn: &Connection,
    snapshot_id: i64,
    limit: usize,
) -> Result<Vec<FolderRankRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path, name, size_bytes, depth
             FROM entries
             WHERE snapshot_id=?1 AND is_dir=1 AND is_reparse=0 AND depth>0
             ORDER BY size_bytes DESC, path ASC
             LIMIT ?2",
        )
        .map_err(|x| e(x))?;
    let rows = stmt
        .query_map(params![snapshot_id, limit as i64], |r| {
            Ok(FolderRankRow {
                path: super::legacy_path(r.get(0)?),
                name: super::legacy_path(r.get(1)?),
                size_bytes: r.get::<_, i64>(2)? as u64,
                depth: r.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(|x| e(x))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|x| e(x))?;
    Ok(rows)
}

pub fn schedule(conn: &Connection) -> Result<ScheduleInfo, String> {
    let mut out = ScheduleInfo::default();
    conn.query_row(
        "SELECT frequency, time_hhmm, weekday, enabled, task_name FROM schedules WHERE id=1",
        [],
        |r| {
            out.frequency = r.get(0)?;
            out.time_hhmm = r.get(1)?;
            out.weekday = r.get::<_, i64>(2)? as u8;
            out.enabled = r.get::<_, i64>(3)? != 0;
            out.task_name = r.get(4)?;
            Ok(())
        },
    )
    .optional()
    .map_err(|x| e(x))?;
    Ok(out)
}

pub fn save_schedule(conn: &Connection, s: &ScheduleInfo, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO schedules (id, frequency, time_hhmm, weekday, enabled, task_name, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            s.frequency,
            s.time_hhmm,
            s.weekday as i64,
            s.enabled as i32,
            s.task_name,
            now
        ],
    )
    .map_err(|x| e(x))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diskmon::StoredEntry;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init(&c).unwrap();
        c
    }

    fn entry(path: &str, size: u64, own: u64) -> StoredEntry {
        StoredEntry {
            path: path.into(),
            parent: None,
            name: path.rsplit('\\').next().unwrap().into(),
            is_dir: own == 0,
            size_bytes: size,
            own_bytes: own,
            ext: None,
            mtime: None,
            is_reparse: false,
            depth: 0,
        }
    }

    #[test]
    fn cascade_delete_and_batch_roundtrip() {
        let mut c = mem();
        let id = create_snapshot(&c, 1000, 500, 100).unwrap();
        let rows = vec![entry("C:\\A\\x.txt", 12, 12), entry("C:\\A", 12, 0)];
        insert_batch(&mut c, id, &rows).unwrap();
        insert_errors(
            &mut c,
            id,
            &[ScanError { path: "C:\\Sec".into(), kind: "permission".into(), message: "拒绝访问".into() }],
        )
        .unwrap();
        finish_snapshot(&c, id, "partial", 12, 1, 1, 1, 0, 1001).unwrap();
        let list = list_snapshots(&c).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, "partial");
        assert_eq!(list[0].total_bytes, 12);
        assert_eq!(load_diff_inputs(&c, id).unwrap().len(), 2);
        assert_eq!(list_errors(&c, id, 10).unwrap().len(), 1);

        let n = delete_snapshots(&mut c, &[id]).unwrap();
        assert_eq!(n, 1);
        assert!(list_snapshots(&c).unwrap().is_empty());
        assert!(load_diff_inputs(&c, id).unwrap().is_empty(), "entries 应被级联删除");
        assert!(list_errors(&c, id, 10).unwrap().is_empty(), "错误明细应被级联删除");
    }

    #[test]
    fn prune_keeps_newest_n_and_settings_roundtrip() {
        let mut c = mem();
        for i in 0..8 {
            let id = create_snapshot(&c, 1000 + i, 0, 0).unwrap();
            finish_snapshot(&c, id, "complete", i as u64, 0, 0, 0, 0, 1001 + i).unwrap();
        }
        set_settings(&c, &Settings { max_snapshots: 3, auto_prune: true, ..Default::default() }).unwrap();
        assert_eq!(settings(&c).unwrap().max_snapshots, 3);
        assert_eq!(prune(&mut c, 3).unwrap(), 5);
        let list = list_snapshots(&c).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, 8);
        assert_eq!(trend(&c, 10).unwrap().len(), 3);
    }

    #[test]
    fn history_skips_unusable_scans_and_returns_latest_points_in_order() {
        let c = mem();
        for (i, status) in ["complete", "complete", "partial", "cancelled", "failed", "running"].into_iter().enumerate() {
            let started = 100 + i as i64;
            let id = create_snapshot(&c, started, 0, 0).unwrap();
            finish_snapshot(&c, id, status, 1, 1, 0, 0, 0, started + 1).unwrap();
        }
        let ids: Vec<_> = trend(&c, 2).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, [2, 3]);
    }

    #[test]
    fn compatible_paths_and_rankings_follow_their_snapshots() {
        let mut c = mem();
        let a = create_snapshot(&c, 100, 0, 0).unwrap();
        let b = create_snapshot(&c, 200, 0, 0).unwrap();
        let mut old = entry("67:\\A", 10, 10);
        old.parent = Some("67:".into());
        insert_batch(&mut c, a, &[old]).unwrap();
        let mut new = entry("C:\\A", 20, 20);
        new.parent = Some(ROOT.into());
        insert_batch(&mut c, b, &[new]).unwrap();
        let old_children = load_children(&c, a, ROOT).unwrap();
        let new_children = load_children(&c, b, ROOT).unwrap();
        let rankings = super::super::diff::overview_rankings(&old_children, &new_children);
        assert_eq!(rankings.growth.len(), 1);
        assert_eq!(rankings.growth[0].delta, 10);
        save_rankings(&c, a, b, &rankings).unwrap();
        assert!(cached_rankings(&c, a, b).unwrap().is_some());
        save_folders(&c, a, &[]).unwrap();
        assert!(cached_folders(&c, a).unwrap().is_some());
        discard_snapshot(&mut c, a, "cancelled", 0, 0).unwrap();
        assert!(load_diff_inputs(&c, a).unwrap().is_empty());
        delete_snapshots(&mut c, &[a]).unwrap();
        assert!(cached_rankings(&c, a, b).unwrap().is_none());
        assert!(cached_folders(&c, a).unwrap().is_none());
    }
}
