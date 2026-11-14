//! 端到端正确性测试：构造两棵临时目录树（测试夹具，不代表产品路径），
//! 走「扫描条目 → 后序汇总 → 批量写库 → 读回 → 全外连接对比」整条链路，
//! 验证目录大小与变化量在落库往返后仍然精确、且父目录不被子目录重复放大。

use crate::diskmon::aggregate::{depth_of, into_stored, parent_of, root_total};
use crate::diskmon::db;
use crate::diskmon::diff::{self, DiffInput, DiffRow, Filter, SortKey};
use crate::diskmon::{RawEntry, StoredEntry};

fn file(path: &str, size: u64) -> RawEntry {
    RawEntry {
        path: path.into(),
        parent: parent_of(path),
        name: path.rsplit('\\').next().unwrap().to_string(),
        is_dir: false,
        own_bytes: size,
        ext: path.rsplit('.').next().map(|s| s.to_string()),
        mtime: None,
        is_reparse: false,
        depth: depth_of(path),
    }
}
fn dir(path: &str) -> RawEntry {
    let mut e = file(path, 0);
    e.is_dir = true;
    e.ext = None;
    e
}
fn to_input(rows: &[StoredEntry]) -> Vec<DiffInput> {
    rows.iter()
        .map(|e| DiffInput {
            path: e.path.clone(),
            parent: e.parent.clone(),
            name: e.name.clone(),
            is_dir: e.is_dir,
            size_bytes: e.size_bytes,
            ext: e.ext.clone(),
            depth: e.depth,
        })
        .collect()
}
fn find<'a>(rows: &'a [DiffRow], p: &str) -> &'a DiffRow {
    rows.iter().find(|r| r.path == p).unwrap_or_else(|| panic!("缺少变化行 {p}"))
}

/// A 快照：A 目录 150 B、B 目录 30 B，根 180 B。
fn tree_a() -> Vec<RawEntry> {
    vec![
        dir("C:\\"),
        dir("C:\\A"),
        dir("C:\\B"),
        file("C:\\A\\x.bin", 100),
        file("C:\\A\\y.bin", 50),
        file("C:\\B\\z.bin", 30),
    ]
}
/// B 快照：x.bin 100→250、y.bin 删除、B 目录新增 new.dat 20、z.bin 不变，根 300 B。
fn tree_b() -> Vec<RawEntry> {
    vec![
        dir("C:\\"),
        dir("C:\\A"),
        dir("C:\\B"),
        file("C:\\A\\x.bin", 250),
        file("C:\\B\\z.bin", 30),
        file("C:\\B\\new.dat", 20),
    ]
}

#[test]
fn aggregate_then_diff_matches_exact_expected_deltas() {
    let sa = into_stored(tree_a());
    let sb = into_stored(tree_b());
    assert_eq!(root_total(&sa), 180, "A 根应等于所有文件之和");
    assert_eq!(root_total(&sb), 300, "B 根应等于所有文件之和");
    assert_eq!(sa.iter().find(|e| e.path == "C:\\A").unwrap().size_bytes, 150);
    assert_eq!(sb.iter().find(|e| e.path == "C:\\A").unwrap().size_bytes, 250);

    let ia = to_input(&sa);
    let ib = to_input(&sb);
    let res = diff::diff_snapshots(&ia, &ib, SortKey::Growth, Filter::All, 100);

    assert_eq!(find(&res.ranking, "C:\\").delta, 120);
    assert_eq!(find(&res.ranking, "C:\\A").delta, 100);
    assert_eq!(find(&res.ranking, "C:\\A\\x.bin").delta, 150);
    assert_eq!(find(&res.ranking, "C:\\A\\y.bin").kind, diff::ChangeKind::Removed);
    assert_eq!(find(&res.ranking, "C:\\A\\y.bin").delta, -50);
    assert_eq!(find(&res.ranking, "C:\\B").delta, 20);
    assert_eq!(find(&res.ranking, "C:\\B\\new.dat").kind, diff::ChangeKind::Added);
    assert_eq!(find(&res.ranking, "C:\\B\\new.dat").delta, 20);
    assert!(!res.ranking.iter().any(|r| r.path == "C:\\B\\z.bin"), "未变化文件不应出现在结果里");

    // 自洽快照下父 delta 应等于直属子 delta 之和 —— 而不是被重复放大。
    let sum_a: i64 = res.ranking
        .iter()
        .filter(|r| r.parent.as_deref() == Some("C:\\A"))
        .map(|r| r.delta)
        .sum();
    assert_eq!(find(&res.ranking, "C:\\A").delta, sum_a);
    let sum_root: i64 = res.ranking
        .iter()
        .filter(|r| r.parent.as_deref() == Some("C:\\"))
        .map(|r| r.delta)
        .sum();
    assert_eq!(find(&res.ranking, "C:\\").delta, sum_root);
    assert!(find(&res.ranking, "C:\\").delta < find(&res.ranking, "C:\\A").delta + find(&res.ranking, "C:\\A\\x.bin").delta);
}

#[test]
fn database_roundtrip_keeps_diff_identical() {
    let sa = into_stored(tree_a());
    let sb = into_stored(tree_b());
    let expected = diff::diff_snapshots(&to_input(&sa), &to_input(&sb), SortKey::Growth, Filter::All, 100);

    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    db::init(&conn).unwrap();
    let ida = db::create_snapshot(&conn, 1_000, 0, 0).unwrap();
    let idb = db::create_snapshot(&conn, 2_000, 0, 0).unwrap();
    db::insert_batch(&mut conn, ida, &sa).unwrap();
    db::insert_batch(&mut conn, idb, &sb).unwrap();
    db::finish_snapshot(&conn, ida, "complete", 180, 3, 2, 0, 0, 1_010).unwrap();
    db::finish_snapshot(&conn, idb, "complete", 300, 3, 2, 0, 0, 2_010).unwrap();

    let ea = db::load_diff_inputs(&conn, ida).unwrap();
    let eb = db::load_diff_inputs(&conn, idb).unwrap();
    assert_eq!(ea.len(), sa.len());
    assert_eq!(eb.len(), sb.len());
    let got = diff::diff_snapshots(&ea, &eb, SortKey::Growth, Filter::All, 100);
    assert_eq!(got.total_changed, expected.total_changed);
    for r in &expected.ranking {
        let g = find(&got.ranking, &r.path);
        assert_eq!(g.delta, r.delta, "{} 的变化量在落库往返后改变", r.path);
        assert_eq!(g.kind, r.kind, "{} 的状态在落库往返后改变", r.path);
        assert_eq!(g.size_a, r.size_a);
        assert_eq!(g.size_b, r.size_b);
    }

    let list = db::list_snapshots(&conn).unwrap();
    assert_eq!(list.len(), 2);
    assert!(diff::reliable(&list[0].status, &list[1].status));
}

/// 首页「文件夹占用空间排行」：按后序汇总的递归大小降序，排除根目录与重解析点，
/// 且父目录排在子目录之前（因为包含它），大小不会被子目录重复放大。
#[test]
fn folder_ranking_uses_recursive_sizes() {
    let mut rows = into_stored(vec![
        dir("C:\\"),
        dir("C:\\A"),
        dir("C:\\A\\Sub"),
        dir("C:\\B"),
        dir("C:\\Junction"),
        file("C:\\A\\Sub\\big.bin", 500),
        file("C:\\A\\a.bin", 100),
        file("C:\\B\\b.bin", 50),
        file("C:\\root.bin", 10),
    ]);
    assert_eq!(root_total(&rows), 660, "根应等于所有文件之和");
    // Junction 是重解析点，默认不跟随，也不计入占用排行
    rows.iter_mut().find(|e| e.path == "C:\\Junction").unwrap().is_reparse = true;

    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    db::init(&conn).unwrap();
    let id = db::create_snapshot(&conn, 3_000, 0, 0).unwrap();
    db::insert_batch(&mut conn, id, &rows).unwrap();
    db::finish_snapshot(&conn, id, "complete", 660, 4, 4, 0, 1, 3_010).unwrap();

    let rank = db::folder_ranking(&conn, id, 10).unwrap();
    assert_eq!(rank.len(), 3, "只应剩下 A / A\\Sub / B 三个普通目录");
    assert!(rank.iter().all(|r| r.path != "C:\\"), "根目录不应占榜首");
    assert!(rank.iter().all(|r| r.path != "C:\\Junction"), "重解析点不应进入排行");
    assert_eq!(rank[0].path, "C:\\A");
    assert_eq!(rank[0].size_bytes, 600, "A 应包含子目录 Sub 的 500 B 与直属文件 100 B");
    assert_eq!(rank[1].path, "C:\\A\\Sub");
    assert_eq!(rank[1].size_bytes, 500);
    assert_eq!(rank[2].path, "C:\\B");
    assert_eq!(rank[2].size_bytes, 50);
    assert!(rank.windows(2).all(|w| w[0].size_bytes >= w[1].size_bytes), "必须按体积降序");
    assert!(rank[0].size_bytes <= root_total(&rows), "目录不能超过根总量");

    let top2 = db::folder_ranking(&conn, id, 2).unwrap();
    assert_eq!(top2.len(), 2);
    assert_eq!(top2[0].path, "C:\\A");
    assert_eq!(top2[1].path, "C:\\A\\Sub");
}
