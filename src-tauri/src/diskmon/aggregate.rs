//! 目录大小的后序递归汇总（纯函数，可单测）。
//!
//! 正确性要点：
//!   * 每个文件只在「直接父目录」处累加一次 own_bytes；
//!   * 按路径深度**降序**处理，先把所有子节点汇总到父，再让父汇总到祖父；
//!   * 父目录的 size_bytes 不通过二次遍历 entries 求和，避免重复计数；
//!   * 缺失的祖先目录会被补建（权限/竞态下可能丢目录条目），保证根值 == 所有文件之和。

use crate::diskmon::{RawEntry, StoredEntry, ROOT};
use std::collections::{HashMap, HashSet};

/// 由规范化路径求父路径。`C:\` 没有父；`C:\A` 的父是 `C:\`。
pub fn parent_of(path: &str) -> Option<String> {
    if path.eq_ignore_ascii_case(ROOT) || path.len() <= 3 {
        return None;
    }
    let trimmed = path.trim_end_matches('\\');
    let pos = trimmed.rfind('\\')?;
    let head = &trimmed[..pos];
    // "C:" → "C:\"
    if head.len() == 2 && head.as_bytes().get(1) == Some(&b':') {
        Some(format!("{head}\\"))
    } else {
        Some(head.to_string())
    }
}

/// 深度：`C:\` = 0，`C:\A` = 1，`C:\A\b.txt` = 2。
pub fn depth_of(path: &str) -> usize {
    path.trim_end_matches('\\').matches('\\').count()
}

/// 补建缺失的祖先目录，返回新增数量。调用方应在 aggregate 之前执行。
pub fn fill_ancestors(entries: &mut Vec<RawEntry>) -> usize {
    let mut known: HashSet<String> = entries.iter().map(|e| e.path.clone()).collect();
    let mut added = 0usize;
    let mut i = 0usize;
    while i < entries.len() {
        let mut cur = entries[i].parent.clone();
        while let Some(p) = cur {
            if known.contains(&p) {
                break;
            }
            known.insert(p.clone());
            entries.push(RawEntry {
                parent: parent_of(&p),
                name: p.trim_end_matches('\\').rsplit('\\').next().unwrap_or(p.as_str()).to_string(),
                is_dir: true,
                own_bytes: 0,
                ext: None,
                mtime: None,
                is_reparse: false,
                depth: depth_of(&p),
                path: p.clone(),
            });
            added += 1;
            cur = parent_of(&p);
        }
        i += 1;
    }
    added
}

/// 返回与 entries 下标一一对应的递归汇总大小。
pub fn aggregate_sizes(entries: &[RawEntry]) -> Vec<u64> {
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        index.insert(e.path.as_str(), i);
    }
    let mut sizes: Vec<u64> = entries.iter().map(|e| e.own_bytes).collect();
    let mut order: Vec<usize> = (0..entries.len()).collect();
    // 深度降序；同深度之间顺序无关（不存在互相为祖先的情况）
    order.sort_unstable_by(|&a, &b| entries[b].depth.cmp(&entries[a].depth));
    for i in order {
        let s = sizes[i];
        if let Some(p) = entries[i].parent.as_deref() {
            if let Some(&pi) = index.get(p) {
                sizes[pi] = sizes[pi].saturating_add(s);
            }
        }
    }
    sizes
}

/// 一步到位：补祖先 → 汇总 → 生成入库结构。
pub fn into_stored(mut entries: Vec<RawEntry>) -> Vec<StoredEntry> {
    fill_ancestors(&mut entries);
    let sizes = aggregate_sizes(&entries);
    entries
        .into_iter()
        .zip(sizes)
        .map(|(e, size_bytes)| StoredEntry {
            path: e.path,
            parent: e.parent,
            name: e.name,
            is_dir: e.is_dir,
            size_bytes,
            own_bytes: e.own_bytes,
            ext: e.ext,
            mtime: e.mtime,
            is_reparse: e.is_reparse,
            depth: e.depth,
        })
        .collect()
}

/// 根节点汇总大小（不等于 sum(entries.size_bytes)，后者会重复计数）。
pub fn root_total(entries: &[StoredEntry]) -> u64 {
    entries
        .iter()
        .find(|e| e.path.eq_ignore_ascii_case(ROOT))
        .map(|e| e.size_bytes)
        .unwrap_or_else(|| entries.iter().filter(|e| !e.is_dir).map(|e| e.own_bytes).sum())
}

// ────────────────────────────── 单元测试 ──────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

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
    fn get<'a>(rows: &'a [StoredEntry], path: &str) -> &'a StoredEntry {
        rows.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("缺少 {path}"))
    }

    fn sample_tree() -> Vec<RawEntry> {
        vec![
            dir("C:\\"),
            dir("C:\\A"),
            dir("C:\\A\\B"),
            dir("C:\\C"),
            file("C:\\A\\a1.txt", 10),
            file("C:\\A\\a2.txt", 5),
            file("C:\\A\\B\\b1.bin", 20),
            file("C:\\A\\B\\b2.bin", 30),
            file("C:\\C\\c1.txt", 7),
            file("C:\\top.log", 3),
        ]
    }

    #[test]
    fn nested_sizes_are_exact_and_not_double_counted() {
        let rows = into_stored(sample_tree());
        assert_eq!(get(&rows, "C:\\A\\B").size_bytes, 50, "B 应为两个直属文件之和");
        assert_eq!(get(&rows, "C:\\A").size_bytes, 65, "A = 直属 15 + B 50");
        assert_eq!(get(&rows, "C:\\C").size_bytes, 7);
        assert_eq!(get(&rows, "C:\\").size_bytes, 75, "根 = 所有文件之和");
        assert_eq!(root_total(&rows), 75);
        // 防呆：把所有 entries 的 size_bytes 相加会得到 50+65+7+75+...，远大于 75
        let naive: u64 = rows.iter().map(|e| e.size_bytes).sum();
        assert!(naive > 75, "naive 求和应明显重复计数，才能证明本测试有效");
        // 文件节点自身 size 不变，目录 own_bytes 恒为 0
        assert_eq!(get(&rows, "C:\\A\\a1.txt").size_bytes, 10);
        assert_eq!(get(&rows, "C:\\A").own_bytes, 0);
    }

    #[test]
    fn missing_ancestors_are_filled_so_root_stays_exact() {
        let mut v = vec![file("C:\\A\\B\\x.dat", 42)];
        let added = fill_ancestors(&mut v);
        assert_eq!(added, 3, "应补 C:\\A\\B、C:\\A、C:\\");
        let rows = into_stored(v);
        assert_eq!(get(&rows, "C:\\A\\B").size_bytes, 42);
        assert_eq!(get(&rows, "C:\\A").size_bytes, 42);
        assert_eq!(root_total(&rows), 42);
    }

    #[test]
    fn parent_and_depth_are_consistent() {
        assert_eq!(parent_of("C:\\"), None);
        assert_eq!(parent_of("C:\\A"), Some("C:\\".into()));
        assert_eq!(parent_of("C:\\A\\B\\x.txt"), Some("C:\\A\\B".into()));
        assert_eq!(depth_of("C:\\"), 0);
        assert_eq!(depth_of("C:\\A"), 1);
        assert_eq!(depth_of("C:\\A\\B\\x.txt"), 3);
    }

    /// 大量小文件：验证 O(n) 聚合、无递归栈溢出、根值精确。
    #[test]
    fn hundred_thousand_small_files_aggregate_exactly() {
        let mut v = Vec::with_capacity(100_000 + 3);
        v.push(dir("C:\\"));
        v.push(dir("C:\\Many"));
        let mut expect = 0u64;
        for i in 0..100_000u64 {
            let p = format!("C:\\Many\\f{i:06}.dat");
            let sz = (i % 7) + 1;
            expect += sz;
            v.push(file(&p, sz));
        }
        let t0 = std::time::Instant::now();
        let rows = into_stored(v);
        let elapsed = t0.elapsed();
        assert_eq!(get(&rows, "C:\\Many").size_bytes, expect);
        assert_eq!(root_total(&rows), expect);
        assert_eq!(rows.len(), 100_002);
        assert!(
            elapsed.as_secs() < 20,
            "10 万条目聚合耗时异常：{:?}",
            elapsed
        );
    }
}
