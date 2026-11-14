//! 平台能力：仅 C 盘卷容量、资源管理器定位、Windows 任务计划程序。
//!
//! 计划任务采用「schtasks 注册一个静默扫描命令行」的方式：
//! 到点由任务计划程序拉起本程序 → `setup` 检测 `--diskmon-silent-scan`
//! → 扫描写库 → 立即退出，主程序无需常驻。

use crate::diskmon::{ScheduleInfo, VolumeInfo, ROOT, SCHEDULE_TASK};

pub const SILENT_ARG: &str = "--diskmon-silent-scan";

pub fn silent_scan_requested() -> bool {
    std::env::args().any(|a| a.eq_ignore_ascii_case(SILENT_ARG))
}

#[cfg(windows)]
pub fn volume_c() -> VolumeInfo {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = OsStr::new(ROOT).encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let mut total_free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free) };
    if ok == 0 {
        VolumeInfo { total: 0, free: 0, used: 0 }
    } else {
        VolumeInfo { total, free, used: total.saturating_sub(total_free) }
    }
}

#[cfg(not(windows))]
pub fn volume_c() -> VolumeInfo {
    VolumeInfo { total: 0, free: 0, used: 0 }
}

/// 把外部传入的定位路径规范化成 Windows 反斜杠形式，并强制限定在 C:\ 范围内。
///
/// 纯函数（不触碰文件系统），便于单测。界面/数据库可能传来 `C:/...`、`c:\...`、
/// `\\?\C:\...`、带引号或只有 `C:` 的写法，早期版本只认字面量 `C:\` 前缀，
/// 会把「明明是 C 盘」的路径误判为越界并弹出一条没有上下文的错误提示。
pub fn normalize_reveal_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let shown = if trimmed.is_empty() { "(空路径)" } else { trimmed };
    let mut s = super::legacy_path(super::normalize_path(std::path::Path::new(trimmed.trim_matches('"'))));
    if s.len() == 2 && s.eq_ignore_ascii_case("c:") {
        s.push('\\');
    }
    if !s.starts_with(ROOT) || s.split('\\').any(|p| matches!(p, "." | "..")) {
        return Err(format!(
            "无法定位「{shown}」：本工具只扫描 C 盘，只能定位 C 盘内的路径"
        ));
    }
    Ok(s)
}

/// 在资源管理器中定位（目录直接打开，文件则选中）。只允许定位 C 盘内的路径。
pub fn reveal(path: &str) -> Result<(), String> {
    let p = normalize_reveal_path(path)?;
    let target = std::path::Path::new(&p);
    if target.is_file() {
        return crate::reveal_file_in_explorer(target);
    }
    let dir = target.ancestors().find(|p| p.is_dir())
        .ok_or_else(|| format!("找不到可打开的目录：{p}"))?;
    crate::command_no_window("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开资源管理器：{e}"))
}

fn schtasks(args: &[&str]) -> Result<(bool, String), String> {
    let out = crate::command_no_window("schtasks")
        .args(args)
        .output()
        .map_err(|e| format!("无法调用任务计划程序：{e}"))?;
    // Windows 中文版 schtasks 输出是 GBK，直接解码会乱码，这里只取状态与固定中文说明，
    // 需要看原始输出时把 stderr 的关键字做 ASCII 判断即可。
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok((out.status.success(), text))
}

fn weekday_arg(weekday: u8) -> &'static str {
    match weekday {
        1 => "MON",
        2 => "TUE",
        3 => "WED",
        4 => "THU",
        5 => "FRI",
        6 => "SAT",
        _ => "SUN",
    }
}

/// 注册（覆盖式）每日 / 每周静默扫描任务。
#[cfg(windows)]
pub fn register_schedule(info: &ScheduleInfo) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法取得程序路径：{e}"))?;
    let tr = format!("\"{}\" {SILENT_ARG}", exe.display());
    let sc = if info.frequency == "weekly" { "WEEKLY" } else { "DAILY" };
    let mut owned = vec![
        "/Create".to_string(),
        "/TN".to_string(),
        SCHEDULE_TASK.to_string(),
        "/TR".to_string(),
        tr,
        "/SC".to_string(),
        sc.to_string(),
        "/ST".to_string(),
        info.time_hhmm.clone(),
    ];
    if info.frequency == "weekly" {
        owned.push("/D".to_string());
        owned.push(weekday_arg(info.weekday).to_string());
    }
    owned.push("/F".to_string());
    let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
    let (ok, _) = schtasks(&refs)?;
    if !ok {
        return Err("任务计划程序拒绝注册（可能需要以当前用户身份运行或时间格式不正确）".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn register_schedule(_info: &ScheduleInfo) -> Result<(), String> {
    Err("自动扫描仅支持 Windows 任务计划程序".into())
}

#[cfg(windows)]
pub fn remove_schedule() -> Result<(), String> {
    let (ok, _) = schtasks(&["/Delete", "/TN", SCHEDULE_TASK, "/F"])?;
    if !ok {
        // 任务本来就不存在不算错误
        let (exists, _) = query_schedule()?;
        if exists {
            return Err("删除计划任务失败".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn remove_schedule() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn query_schedule() -> Result<(bool, String), String> {
    let (ok, _) = schtasks(&["/Query", "/TN", SCHEDULE_TASK])?;
    Ok((ok, if ok { "已在任务计划程序中注册".into() } else { "未注册".into() }))
}

#[cfg(not(windows))]
pub fn query_schedule() -> Result<(bool, String), String> {
    Ok((false, "仅 Windows 支持".into()))
}

#[cfg(test)]
mod tests {
    use super::normalize_reveal_path;

    #[test]
    fn reveal_accepts_all_common_c_drive_forms() {
        let cases: &[(&str, &str)] = &[
            (r"C:\Users\25351", r"C:\Users\25351"),
            (r"C:\", r"C:\"),
            ("c:/Users/25351/Downloads", r"C:\Users\25351\Downloads"),
            (r"c:\Windows\WinSxS", r"C:\Windows\WinSxS"),
            (r"\\?\C:\Windows", r"C:\Windows"),
            (r#""C:\Program Files""#, r"C:\Program Files"),
            ("  C:/Users/25351/AppData  ", r"C:\Users\25351\AppData"),
            ("C:", "C:\\"),
            ("67:\\Windows", "C:\\Windows"),
        ];
        for (raw, want) in cases {
            assert_eq!(normalize_reveal_path(raw).as_deref(), Ok(*want), "输入：{raw}");
        }
    }

    #[test]
    fn reveal_rejects_out_of_scope_paths_with_context() {
        for raw in [r"D:\Projects", r"E:/data", r"\\server\share\x", r"relative\path", r"C:\..\data", "", "   "] {
            let err = normalize_reveal_path(raw).expect_err("越界路径必须被拒绝");
            assert!(err.contains("只能定位 C 盘内的路径"), "{raw} -> {err}");
            assert!(err.contains('「'), "错误信息应带上实际收到的路径：{err}");
        }
    }
}
