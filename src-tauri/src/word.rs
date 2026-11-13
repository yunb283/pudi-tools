use std::path::PathBuf;

#[tauri::command]
pub async fn convert_word_to_pdf(
    path: PathBuf,
    page: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    if page == Some(0) {
        return Err("页码必须从 1 开始".into());
    }
    tauri::async_runtime::spawn_blocking(move || convert(&path, page).map(tauri::ipc::Response::new))
        .await
        .map_err(|error| format!("文档转换任务异常：{error}"))?
}

#[cfg(not(windows))]
fn convert(_path: &std::path::Path, _page: Option<u32>) -> Result<Vec<u8>, String> {
    Err("Word 转换需要 Windows 桌面版".into())
}

#[cfg(windows)]
fn convert(path: &std::path::Path, page: Option<u32>) -> Result<Vec<u8>, String> {
    use std::ffi::OsStr;
    use std::fs;
    use std::path::Path;

    let ext = path.extension().and_then(OsStr::to_str).unwrap_or_default();
    if !["doc", "docx"]
        .iter()
        .any(|supported| ext.eq_ignore_ascii_case(supported))
    {
        return Err("请选择 .doc 或 .docx 文件".into());
    }
    let source = fs::canonicalize(path).map_err(|error| format!("无法打开源文件：{error}"))?;
    if !fs::metadata(&source).is_ok_and(|info| info.is_file()) {
        return Err("请选择有效的 Word 文档".into());
    }
    // Word and LibreOffice expect the conventional Win32 path syntax.
    let source = source.as_os_str().to_string_lossy();
    let source = if let Some(unc) = source.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        source.strip_prefix(r"\\?\").unwrap_or(&source).to_owned()
    };
    let workspace = Workspace::new()?;
    let output = workspace.0.join("document.pdf");
    let powershell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = crate::command_no_window(powershell);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WORD_EXPORT])
        .env("PUDI_WORD_SOURCE", &source)
        .env("PUDI_WORD_OUTPUT", &output)
        .env(
            "PUDI_WORD_PAGE",
            page.map(|value| value.to_string()).unwrap_or_default(),
        );

    let result = run(command, &workspace.0)?;
    match result.code() {
        Some(0) => read_pdf(&output),
        Some(21) => {
            let soffice = find_libreoffice().ok_or(
                "未找到 Microsoft Word 或 LibreOffice。请安装其中之一后再转换。",
            )?;
            // LibreOffice names the resulting PDF after the source document.
            let input = Path::new(&source);
            let mut pdf = workspace.0.join(input.file_name().ok_or("文件名无效")?);
            pdf.set_extension("pdf");
            let profile = tauri::Url::from_directory_path(workspace.0.join("profile"))
                .map_err(|_| "无法初始化 LibreOffice 临时配置")?;
            let filter = match page {
                Some(value) => format!(
                    r#"pdf:writer_pdf_Export:{{"PageRange":{{"type":"string","value":"{value}"}}}}"#
                ),
                None => "pdf:writer_pdf_Export".into(),
            };
            let mut command = crate::command_no_window(soffice);
            command
                .arg(format!("-env:UserInstallation={profile}"))
                .args(["--headless", "--convert-to", &filter, "--outdir"])
                .arg(&workspace.0)
                .arg(input);
            let status = run(command, &workspace.0)?;
            if !status.success() {
                return Err(conversion_error(&workspace.0));
            }
            read_pdf(&pdf)
        }
        _ => Err(conversion_error(&workspace.0)),
    }
}

#[cfg(windows)]
const WORD_EXPORT: &str = include_str!("word-export.ps1");

#[cfg(windows)]
struct Workspace(PathBuf);

#[cfg(windows)]
impl Workspace {
    fn new() -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("pudi-word-{}-{time}-{id}", std::process::id()));
        std::fs::create_dir(&path).map_err(|error| format!("无法创建临时目录：{error}"))?;
        Ok(Self(path))
    }
}

#[cfg(windows)]
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(windows)]
fn find_libreoffice() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|dir| PathBuf::from(dir).join(r"LibreOffice\program"))
        .chain(std::env::var_os("PATH").iter().flat_map(std::env::split_paths))
        .flat_map(|dir| [dir.join("soffice.com"), dir.join("soffice.exe")])
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn run(
    mut command: std::process::Command,
    dir: &std::path::Path,
) -> Result<std::process::ExitStatus, String> {
    use std::fs::File;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let log = File::create(dir.join("conversion.log"))
        .map_err(|error| format!("无法写入转换日志：{error}"))?;
    let stdout = log.try_clone().map_err(|error| error.to_string())?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(log)
        .spawn()
        .map_err(|error| format!("无法启动 Word 转换：{error}"))?;
    let job = crate::kill_tree_job::KillTreeJob::new();
    if let Some(job) = &job {
        job.assign(&child);
    }
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(75)),
            status => {
                if let Some(job) = &job {
                    job.kill();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(match status {
                    Err(error) => format!("转换进程异常：{error}"),
                    _ => "转换超时。请检查文档能否在 Word 或 LibreOffice 中正常打开。".into(),
                });
            }
        }
    }
}

#[cfg(windows)]
fn read_pdf(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let data = std::fs::read(path).map_err(|_| "未生成 PDF，请检查文档是否损坏或受密码保护")?;
    if !data.starts_with(b"%PDF-") {
        return Err("转换结果不是有效的 PDF".into());
    }
    Ok(data)
}

#[cfg(windows)]
fn conversion_error(dir: &std::path::Path) -> String {
    let log = std::fs::read(dir.join("conversion.log")).unwrap_or_default();
    let log = String::from_utf8_lossy(&log);
    let detail = log.lines().rev().find(|line| !line.trim().is_empty());
    match detail {
        Some(message) => format!("Word 转换失败：{}", message.trim()),
        None => "Word 转换失败。请检查文档是否损坏或受密码保护。".into(),
    }
}
