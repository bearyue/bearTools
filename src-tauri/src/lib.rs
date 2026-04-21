use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::spawn_blocking;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as HotKeyState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdbCommandResult {
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdbDevice {
    serial: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdbDevicesResult {
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    success: bool,
    devices: Vec<AdbDevice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLaunchOptions {
    app: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTerminalRequest {
    path: String,
    command: String,
    terminal: Option<TerminalLaunchOptions>,
    title: Option<String>,
    open_in_new_window: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JxLogProfile {
    name: String,
    source: String,
    url: String,
    user: String,
    password: String,
    hosts: Vec<String>,
    path: String,
    proxy: String,
    ssh_hostkey: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JxLogEnvMapping {
    name: String,
    profile: String,
    aliases: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JxLogProjectMapping {
    path: String,
    default_env: String,
    envs: Vec<JxLogEnvMapping>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JxLogConfigBundle {
    script_root: String,
    config_ini_path: String,
    project_map_path: String,
    profiles: Vec<JxLogProfile>,
    projects: Vec<JxLogProjectMapping>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JxLogRuntimeValidation {
    script_root: String,
    config_ini_path: String,
    project_map_path: String,
    fetch_script_exists: bool,
    config_ini_exists: bool,
    project_map_exists: bool,
    python_command: String,
    python_available: bool,
    python_version_output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JxLogExecutionRequest {
    python_command: String,
    fetch_script_path: String,
    action: String,
    profile: Option<String>,
    env: Option<String>,
    project_dir: Option<String>,
    module: Option<String>,
    log_type: Option<String>,
    time: Option<String>,
    end: Option<String>,
    range_hours: Option<f64>,
    grep: Option<String>,
    host: Option<String>,
    output_path: Option<String>,
    tail: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JxLogExecutionResult {
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    success: bool,
    output_path: Option<String>,
    diagnostics: JxLogExecutionDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JxLogExecutionDiagnostics {
    requested_profile: Option<String>,
    resolved_profile: Option<String>,
    config_ini_path: String,
    project_map_path: String,
    source: Option<String>,
    url: Option<String>,
    user: Option<String>,
    hosts: Vec<String>,
    path: Option<String>,
    request_targets: Vec<String>,
}
fn require_non_empty(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name}不能为空"));
    }

    Ok(trimmed.to_string())
}

fn jxlog_default_profile(name: &str) -> JxLogProfile {
    JxLogProfile {
        name: name.to_string(),
        source: "portal".to_string(),
        url: "https://jxprotal.aviva-cofco.com.cn/applog/".to_string(),
        user: "admin".to_string(),
        password: String::new(),
        hosts: vec!["st".to_string(), "zy".to_string()],
        path: "gw_container".to_string(),
        proxy: String::new(),
        ssh_hostkey: String::new(),
    }
}

fn jxlog_derive_paths(fetch_script_path: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let script_path = PathBuf::from(require_non_empty(fetch_script_path, "fetch_log.py 路径")?);
    let script_root = script_path
        .parent()
        .ok_or_else(|| "无法从脚本路径推导脚本目录".to_string())?
        .to_path_buf();
    let config_ini_path = script_root.join("fetch_log.ini");
    let project_map_path = script_root.join("project_profile_map.json");

    Ok((script_root, config_ini_path, project_map_path))
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| format!("路径包含无法识别的字符: {}", path.display()))
}

fn parse_ini_profiles(content: &str) -> Vec<JxLogProfile> {
    let mut profiles: Vec<JxLogProfile> = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_entries: Vec<(String, String)> = Vec::new();

    let flush_section =
        |name: Option<String>, entries: &[(String, String)], out: &mut Vec<JxLogProfile>| {
            let Some(section_name) = name else {
                return;
            };

            let mut profile = jxlog_default_profile(&section_name);
            let mut has_path = false;
            let mut legacy_container: Option<String> = None;
            let mut legacy_log_dir: Option<String> = None;
            for (key, value) in entries {
                match key.as_str() {
                    "source" => profile.source = value.clone(),
                    "url" => profile.url = value.clone(),
                    "user" => profile.user = value.clone(),
                    "password" => profile.password = value.clone(),
                    "hosts" => {
                        profile.hosts = value
                            .split(',')
                            .map(|item| item.trim())
                            .filter(|item| !item.is_empty())
                            .map(|item| item.to_string())
                            .collect();
                    }
                    "path" => {
                        has_path = true;
                        profile.path = value.clone();
                    }
                    "proxy" => profile.proxy = value.clone(),
                    "container" => legacy_container = Some(value.clone()),
                    "log_dir" => legacy_log_dir = Some(value.clone()),
                    "ssh_hostkey" => profile.ssh_hostkey = value.clone(),
                    _ => {}
                }
            }
            if profile.hosts.is_empty() {
                profile.hosts = vec!["st".to_string(), "zy".to_string()];
            }
            if !has_path {
                profile.path = if profile.source.starts_with("ssh") {
                    legacy_log_dir.unwrap_or_else(|| "/jiaxin/logs".to_string())
                } else {
                    legacy_container.unwrap_or_else(|| "gw_container".to_string())
                };
            }
            out.push(profile);
        };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            flush_section(current_name.take(), &current_entries, &mut profiles);
            current_entries.clear();
            current_name = Some(line[1..line.len() - 1].trim().to_string());
            continue;
        }

        if let Some((key, value)) = line.split_once('=') {
            current_entries.push((key.trim().to_string(), value.trim().to_string()));
        }
    }

    flush_section(current_name.take(), &current_entries, &mut profiles);

    if profiles.is_empty() {
        vec![jxlog_default_profile("default")]
    } else {
        profiles
    }
}

fn write_ini_profiles(config_path: &Path, profiles: &[JxLogProfile]) -> Result<(), String> {
    let mut normalized_profiles = profiles.to_vec();
    if normalized_profiles.is_empty() {
        normalized_profiles.push(jxlog_default_profile("default"));
    }

    let mut output = String::new();
    output.push_str("# 佳信日志下载工具配置\n");
    output.push_str("# 由 bearTools 的 jxLog UI 维护\n");
    output.push_str("# 支持多个 profile，用 --profile 切换\n");
    output.push_str("# 建议将密码放到环境变量 APPLOG_PASS / SSH_LOG_PASS，不要提交真实凭据\n\n");

    for profile in normalized_profiles {
        output.push_str(&format!("[{}]\n", profile.name.trim()));
        output.push_str(&format!("source = {}\n", profile.source.trim()));
        output.push_str(&format!("url = {}\n", profile.url.trim()));
        output.push_str(&format!("user = {}\n", profile.user.trim()));
        output.push_str(&format!("password = {}\n", profile.password.trim()));
        output.push_str(&format!("hosts = {}\n", profile.hosts.join(",")));
        output.push_str(&format!("path = {}\n", profile.path.trim()));
        output.push_str(&format!("proxy = {}\n", profile.proxy.trim()));
        output.push_str(&format!("ssh_hostkey = {}\n\n", profile.ssh_hostkey.trim()));
    }

    fs::write(config_path, output).map_err(|error| format!("写入 fetch_log.ini 失败: {error}"))
}

fn load_jxlog_project_map(project_map_path: &Path) -> Result<Vec<JxLogProjectMapping>, String> {
    if !project_map_path.is_file() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(project_map_path)
        .map_err(|error| format!("读取 project_profile_map.json 失败: {error}"))?;

    #[derive(Deserialize)]
    struct RawProjectMap {
        projects: Option<std::collections::BTreeMap<String, RawProjectEntry>>,
    }

    #[derive(Deserialize)]
    struct RawProjectEntry {
        default_env: Option<String>,
        envs: Option<std::collections::BTreeMap<String, RawEnvEntry>>,
    }

    #[derive(Deserialize)]
    struct RawEnvEntry {
        profile: Option<String>,
        aliases: Option<Vec<String>>,
    }

    let parsed: RawProjectMap = serde_json::from_str(&content)
        .map_err(|error| format!("解析 project_profile_map.json 失败: {error}"))?;

    let mut projects = Vec::new();
    if let Some(raw_projects) = parsed.projects {
        for (path, project) in raw_projects {
            let mut envs = Vec::new();
            if let Some(raw_envs) = project.envs {
                for (name, env) in raw_envs {
                    envs.push(JxLogEnvMapping {
                        name,
                        profile: env.profile.unwrap_or_default(),
                        aliases: env.aliases.unwrap_or_default(),
                    });
                }
            }

            projects.push(JxLogProjectMapping {
                path,
                default_env: project.default_env.unwrap_or_default(),
                envs,
            });
        }
    }

    Ok(projects)
}

fn save_jxlog_project_map(
    project_map_path: &Path,
    projects: &[JxLogProjectMapping],
) -> Result<(), String> {
    #[derive(Serialize)]
    struct RawProjectMap<'a> {
        projects: std::collections::BTreeMap<&'a str, RawProjectEntry<'a>>,
    }

    #[derive(Serialize)]
    struct RawProjectEntry<'a> {
        default_env: &'a str,
        envs: std::collections::BTreeMap<&'a str, RawEnvEntry<'a>>,
    }

    #[derive(Serialize)]
    struct RawEnvEntry<'a> {
        profile: &'a str,
        aliases: &'a [String],
    }

    let mut raw_projects = std::collections::BTreeMap::new();
    for project in projects {
        let mut raw_envs = std::collections::BTreeMap::new();
        for env in &project.envs {
            raw_envs.insert(
                env.name.as_str(),
                RawEnvEntry {
                    profile: env.profile.as_str(),
                    aliases: &env.aliases,
                },
            );
        }

        raw_projects.insert(
            project.path.as_str(),
            RawProjectEntry {
                default_env: project.default_env.as_str(),
                envs: raw_envs,
            },
        );
    }

    let content = serde_json::to_string_pretty(&RawProjectMap {
        projects: raw_projects,
    })
    .map_err(|error| format!("序列化 project_profile_map.json 失败: {error}"))?;
    fs::write(project_map_path, format!("{content}\n"))
        .map_err(|error| format!("写入 project_profile_map.json 失败: {error}"))
}

fn extract_jxlog_output_path(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        line.trim()
            .strip_prefix("💾 已保存到: ")
            .map(|value| value.trim().to_string())
    })
}

fn resolve_jxlog_profile_from_request(
    request: &JxLogExecutionRequest,
    projects: &[JxLogProjectMapping],
) -> Option<String> {
    if let Some(profile) = request
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(profile.to_string());
    }

    let project_dir = request
        .project_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let project = projects
        .iter()
        .find(|item| item.path.trim() == project_dir)?;

    if let Some(env_name) = request
        .env
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(env) = project.envs.iter().find(|item| {
            item.name.trim() == env_name
                || item.aliases.iter().any(|alias| alias.trim() == env_name)
        }) {
            return Some(env.profile.trim().to_string());
        }
    }

    let default_env_name = project.default_env.trim();
    if let Some(default_env) = project
        .envs
        .iter()
        .find(|item| item.name.trim() == default_env_name)
    {
        return Some(default_env.profile.trim().to_string());
    }

    project
        .envs
        .first()
        .map(|item| item.profile.trim().to_string())
}

fn build_jxlog_portal_target(
    base_url: &str,
    path_value: &str,
    host: &str,
    parts: &[&str],
    trailing_slash: bool,
) -> String {
    let mut segments = vec![host.trim_matches('/'), path_value.trim_matches('/')]
        .into_iter()
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    segments.extend(
        parts
            .iter()
            .map(|item| item.trim_matches('/'))
            .filter(|item| !item.is_empty())
            .map(ToString::to_string),
    );
    let joined = segments.join("/");
    let normalized_base = if base_url.ends_with('/') {
        base_url.to_string()
    } else {
        format!("{base_url}/")
    };
    if trailing_slash {
        format!("{normalized_base}{joined}/")
    } else {
        format!("{normalized_base}{joined}")
    }
}

fn truncate_for_bridge(value: String, max_chars: usize) -> String {
    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return value;
    }

    let truncated: String = value.chars().take(max_chars).collect();
    let hidden = total_chars.saturating_sub(max_chars);
    format!("{truncated}\n\n... 已在 Rust 侧截断 {hidden} 个字符，避免开发态界面因超大输出白屏。")
}

fn run_python_version_check(python_command: &str) -> (bool, String) {
    match Command::new(python_command).arg("--version").output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let text = if stdout.is_empty() { stderr } else { stdout };
            (output.status.success(), text)
        }
        Err(error) => (false, error.to_string()),
    }
}

fn run_adb_process(args: &[&str]) -> Result<AdbCommandResult, String> {
    let command = format!("adb {}", args.join(" "));
    let output = Command::new("adb").args(args).output().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "未找到 adb 命令，请确认 Android Platform Tools 已安装并已加入 PATH。".to_string()
        } else {
            format!("执行 `{command}` 失败: {error}")
        }
    })?;

    Ok(AdbCommandResult {
        command,
        stdout: String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
        stderr: String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string(),
        exit_code: output.status.code(),
        success: output.status.success(),
    })
}

struct ExitFlag(AtomicBool);
struct GlobalShortcutState(Mutex<Option<String>>);

fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn register_global_shortcut<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut: &str,
) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == HotKeyState::Pressed {
                show_main_window(app);
            }
        })
        .map_err(|error| format!("快捷键注册失败: {error}"))
}

async fn run_adb_blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    spawn_blocking(job)
        .await
        .map_err(|error| format!("执行 adb 任务失败: {error}"))?
}

fn contains_adb_failure_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "failed",
        "failure",
        "cannot",
        "unable",
        "refused",
        "error",
        "timed out",
        "no route to host",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
}

fn adb_pair_succeeded(result: &AdbCommandResult) -> bool {
    let combined = format!("{}\n{}", result.stdout, result.stderr);
    result.exit_code == Some(0) && !contains_adb_failure_text(&combined)
}

fn adb_connect_succeeded(result: &AdbCommandResult) -> bool {
    let combined = format!("{}\n{}", result.stdout, result.stderr);
    let lower = combined.to_ascii_lowercase();
    let has_success_phrase =
        lower.contains("connected to") || lower.contains("already connected to");

    result.exit_code == Some(0) && has_success_phrase && !contains_adb_failure_text(&combined)
}

fn parse_adb_devices(stdout: &str) -> Vec<AdbDevice> {
    stdout
        .lines()
        .skip(1)
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split_whitespace();
            let serial = parts.next()?;
            let status = parts.next()?;

            Some(AdbDevice {
                serial: serial.to_string(),
                status: status.to_string(),
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn resolve_cmd_path() -> String {
    if let Ok(system_root) = std::env::var("SystemRoot") {
        let candidate = format!("{}\\System32\\cmd.exe", system_root.trim_end_matches('\\'));
        if Path::new(&candidate).is_file() {
            return candidate;
        }
    }

    "cmd.exe".to_string()
}

#[cfg(target_os = "windows")]
fn escape_cmd_text(value: &str) -> String {
    value
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('"', "^\"")
}

#[cfg(target_os = "windows")]
fn launch_cmd_console_payload(path: &str, payload: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    let cmd_path = resolve_cmd_path();
    Command::new(cmd_path)
        .args(["/K", payload])
        .creation_flags(CREATE_NEW_CONSOLE)
        .current_dir(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn resolve_powershell_path() -> Option<String> {
    if let Ok(system_root) = std::env::var("SystemRoot") {
        let candidate = format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            system_root.trim_end_matches('\\')
        );
        if Path::new(&candidate).is_file() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn build_powershell_script(path: &str, title: &str, command: &str) -> String {
    let escaped_path = escape_powershell_single_quotes(path);
    let escaped_title = escape_powershell_single_quotes(title);

    let mut statements = vec![
        format!("Set-Location -LiteralPath '{}'", escaped_path),
        format!("$host.UI.RawUI.WindowTitle='{}'", escaped_title),
    ];
    if !command.trim().is_empty() {
        statements.push(command.to_string());
    }
    statements.push("Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force".to_string());
    statements.join("; ")
}

#[cfg(target_os = "windows")]
fn build_cmd_payload_for_powershell(
    path: &str,
    title: &str,
    command: &str,
) -> Result<String, String> {
    let ps_command = build_powershell_script(path, title, command);
    let script_path = create_powershell_script(&ps_command)?;
    let powershell_path = resolve_powershell_path().unwrap_or_else(|| "powershell".to_string());
    let escaped_path = escape_cmd_text(path);
    let escaped_ps = escape_cmd_text(&powershell_path);
    let escaped_script = escape_cmd_text(&script_path);

    Ok(format!(
        "cd /d \"{}\" & \"{}\" -NoExit -ExecutionPolicy Bypass -File \"{}\"",
        escaped_path, escaped_ps, escaped_script
    ))
}

#[cfg(target_os = "windows")]
fn create_powershell_script(script_body: &str) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成脚本时间失败: {error}"))?
        .as_millis();
    let file_name = format!("beartools_terminal_{timestamp}.ps1");
    let script_path = std::env::temp_dir().join(file_name);
    let mut content = Vec::with_capacity(script_body.len() + 3);
    // UTF-8 BOM for Windows PowerShell 5.1 compatibility
    content.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    content.extend_from_slice(script_body.as_bytes());
    fs::write(&script_path, content).map_err(|error| format!("写入临时脚本失败: {error}"))?;
    script_path
        .to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "脚本路径包含无法识别的字符".to_string())
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn escape_shell_single_quotes(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn jxlog_validate_runtime(
    python_command: String,
    fetch_script_path: String,
) -> Result<JxLogRuntimeValidation, String> {
    let python_command = require_non_empty(&python_command, "Python 启动器")?;
    let fetch_script_path = require_non_empty(&fetch_script_path, "fetch_log.py 路径")?;
    let (script_root, config_ini_path, project_map_path) = jxlog_derive_paths(&fetch_script_path)?;
    let (python_available, python_version_output) = run_python_version_check(&python_command);

    Ok(JxLogRuntimeValidation {
        script_root: path_to_string(&script_root)?,
        config_ini_path: path_to_string(&config_ini_path)?,
        project_map_path: path_to_string(&project_map_path)?,
        fetch_script_exists: Path::new(&fetch_script_path).is_file(),
        config_ini_exists: config_ini_path.is_file(),
        project_map_exists: project_map_path.is_file(),
        python_command,
        python_available,
        python_version_output,
    })
}

#[tauri::command]
fn jxlog_load_configuration(fetch_script_path: String) -> Result<JxLogConfigBundle, String> {
    let fetch_script_path = require_non_empty(&fetch_script_path, "fetch_log.py 路径")?;
    let (script_root, config_ini_path, project_map_path) = jxlog_derive_paths(&fetch_script_path)?;
    let profiles = if config_ini_path.is_file() {
        let content = fs::read_to_string(&config_ini_path)
            .map_err(|error| format!("读取 fetch_log.ini 失败: {error}"))?;
        parse_ini_profiles(&content)
    } else {
        vec![jxlog_default_profile("default")]
    };
    let projects = load_jxlog_project_map(&project_map_path)?;

    Ok(JxLogConfigBundle {
        script_root: path_to_string(&script_root)?,
        config_ini_path: path_to_string(&config_ini_path)?,
        project_map_path: path_to_string(&project_map_path)?,
        profiles,
        projects,
    })
}

#[tauri::command]
fn jxlog_save_configuration(
    fetch_script_path: String,
    profiles: Vec<JxLogProfile>,
    projects: Vec<JxLogProjectMapping>,
) -> Result<JxLogConfigBundle, String> {
    let fetch_script_path = require_non_empty(&fetch_script_path, "fetch_log.py 路径")?;
    let (script_root, config_ini_path, project_map_path) = jxlog_derive_paths(&fetch_script_path)?;
    let mut normalized_profiles = if profiles.is_empty() {
        vec![jxlog_default_profile("default")]
    } else {
        profiles
    };
    for profile in &mut normalized_profiles {
        profile.name = require_non_empty(&profile.name, "profile 名称")?;
        profile.source = require_non_empty(&profile.source, "source")?;
        profile.hosts = profile
            .hosts
            .iter()
            .map(|host| host.trim())
            .filter(|host| !host.is_empty())
            .map(|host| host.to_string())
            .collect();
        if profile.hosts.is_empty() {
            profile.hosts = vec!["st".to_string(), "zy".to_string()];
        }
    }

    write_ini_profiles(&config_ini_path, &normalized_profiles)?;
    save_jxlog_project_map(&project_map_path, &projects)?;

    Ok(JxLogConfigBundle {
        script_root: path_to_string(&script_root)?,
        config_ini_path: path_to_string(&config_ini_path)?,
        project_map_path: path_to_string(&project_map_path)?,
        profiles: normalized_profiles,
        projects,
    })
}

#[tauri::command]
async fn jxlog_execute(request: JxLogExecutionRequest) -> Result<JxLogExecutionResult, String> {
    let python_command = require_non_empty(&request.python_command, "Python 启动器")?;
    let fetch_script_path = require_non_empty(&request.fetch_script_path, "fetch_log.py 路径")?;
    let (script_root, config_ini_path, project_map_path) = jxlog_derive_paths(&fetch_script_path)?;
    let action = require_non_empty(&request.action, "执行动作")?;
    let profiles = if config_ini_path.is_file() {
        let content = fs::read_to_string(&config_ini_path)
            .map_err(|error| format!("读取 fetch_log.ini 失败: {error}"))?;
        parse_ini_profiles(&content)
    } else {
        vec![jxlog_default_profile("default")]
    };
    let projects = load_jxlog_project_map(&project_map_path).unwrap_or_default();
    let resolved_profile_name = resolve_jxlog_profile_from_request(&request, &projects);
    let matched_profile = resolved_profile_name
        .as_deref()
        .and_then(|name| profiles.iter().find(|item| item.name.trim() == name))
        .cloned();
    let request_targets = if let Some(profile) = matched_profile.as_ref() {
        if profile.source.trim().starts_with("ssh") {
            Vec::new()
        } else {
            let base_url = profile.url.trim();
            let path_value = profile.path.trim();
            let hosts = if let Some(host) = request
                .host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vec![host.to_string()]
            } else {
                profile.hosts.clone()
            };

            match action.as_str() {
                "listModules" => hosts
                    .iter()
                    .map(|host| build_jxlog_portal_target(base_url, path_value, host, &[], true))
                    .collect(),
                "listFiles" => {
                    let module = request.module.as_deref().map(str::trim).unwrap_or_default();
                    hosts
                        .iter()
                        .map(|host| {
                            build_jxlog_portal_target(base_url, path_value, host, &[module], true)
                        })
                        .collect()
                }
                "downloadCurrent" => {
                    let module = request.module.as_deref().map(str::trim).unwrap_or_default();
                    let log_type = request.log_type.as_deref().map(str::trim).unwrap_or("main");
                    let suffix = match log_type {
                        "main" => ".log".to_string(),
                        "out" => ".out".to_string(),
                        _ => format!("_{log_type}.log"),
                    };
                    let file_name = format!("{module}{suffix}");
                    hosts
                        .iter()
                        .map(|host| {
                            build_jxlog_portal_target(
                                base_url,
                                path_value,
                                host,
                                &[module, &file_name],
                                false,
                            )
                        })
                        .collect()
                }
                _ => hosts
                    .iter()
                    .map(|host| build_jxlog_portal_target(base_url, path_value, host, &[], true))
                    .collect(),
            }
        }
    } else {
        Vec::new()
    };
    let diagnostics = JxLogExecutionDiagnostics {
        requested_profile: request
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        resolved_profile: resolved_profile_name,
        config_ini_path: path_to_string(&config_ini_path)?,
        project_map_path: path_to_string(&project_map_path)?,
        source: matched_profile.as_ref().map(|item| item.source.clone()),
        url: matched_profile.as_ref().map(|item| item.url.clone()),
        user: matched_profile.as_ref().map(|item| item.user.clone()),
        hosts: matched_profile
            .as_ref()
            .map(|item| item.hosts.clone())
            .unwrap_or_default(),
        path: matched_profile.as_ref().map(|item| item.path.clone()),
        request_targets,
    };

    let result = spawn_blocking(move || {
        let mut args = vec![fetch_script_path.clone()];

        if let Some(profile) = request
            .profile
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--profile".to_string());
            args.push(profile.trim().to_string());
        }
        if let Some(env) = request
            .env
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--env".to_string());
            args.push(env.trim().to_string());
        }
        if let Some(project_dir) = request
            .project_dir
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--project-dir".to_string());
            args.push(project_dir.trim().to_string());
        }
        if let Some(module_name) = request
            .module
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--module".to_string());
            args.push(module_name.trim().to_string());
        }
        if let Some(log_type) = request
            .log_type
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--log-type".to_string());
            args.push(log_type.trim().to_string());
        }
        if let Some(host) = request
            .host
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--host".to_string());
            args.push(host.trim().to_string());
        }
        if let Some(pattern) = request
            .grep
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--grep".to_string());
            args.push(pattern.trim().to_string());
        }
        if let Some(output_path) = request
            .output_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--output".to_string());
            args.push(output_path.trim().to_string());
        }
        if let Some(tail) = request.tail.filter(|value| *value > 0) {
            args.push("--tail".to_string());
            args.push(tail.to_string());
        }

        match action.as_str() {
            "listModules" => args.push("--list-modules".to_string()),
            "listFiles" => args.push("--list".to_string()),
            "downloadCurrent" => args.push("--download-current".to_string()),
            "downloadRange" => {
                let time =
                    require_non_empty(request.time.as_deref().unwrap_or_default(), "起始时间")?;
                args.push("--time".to_string());
                args.push(time);

                if let Some(end) = request
                    .end
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    args.push("--end".to_string());
                    args.push(end.trim().to_string());
                } else if let Some(range_hours) = request.range_hours {
                    args.push("--range".to_string());
                    args.push(range_hours.to_string());
                }
            }
            _ => return Err(format!("不支持的 jxLog 动作: {action}")),
        }

        let mut command = Command::new(&python_command);
        command.args(&args).current_dir(&script_root);
        let command_text = format!("{} {}", python_command, args.join(" "));
        let output = command
            .output()
            .map_err(|error| format!("执行 jxLog 脚本失败: {error}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string();
        let safe_stdout = truncate_for_bridge(stdout, 12000);
        let safe_stderr = truncate_for_bridge(stderr.clone(), 12000);

        Ok(JxLogExecutionResult {
            command: command_text,
            stdout: safe_stdout,
            stderr: safe_stderr,
            exit_code: output.status.code(),
            success: output.status.success(),
            output_path: extract_jxlog_output_path(&stderr),
            diagnostics,
        })
    })
    .await
    .map_err(|error| format!("执行 jxLog 任务失败: {error}"))??;

    Ok(result)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_terminal_and_run(request: OpenTerminalRequest) -> Result<(), String> {
    let OpenTerminalRequest {
        path,
        command,
        terminal,
        title,
        open_in_new_window,
    } = request;
    let title = title.unwrap_or_else(|| "终端".to_string());
    let open_in_new_window = open_in_new_window.unwrap_or(false);
    if let Some(terminal) = terminal {
        let app = terminal.app.trim();
        if app.is_empty() {
            return Err("终端启动程序不能为空".to_string());
        }
        if !Path::new(app).is_absolute() {
            return Err("终端启动程序必须是完整路径".to_string());
        }

        let mut launch = Command::new(app);
        if !terminal.args.is_empty() {
            launch.args(terminal.args);
        }
        launch
            .current_dir(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let cmd_path = resolve_cmd_path();
        let cmd_payload = build_cmd_payload_for_powershell(&path, &title, &command)?;
        let mut wt_args: Vec<String> = Vec::new();
        wt_args.push("-w".to_string());
        wt_args.push(if open_in_new_window {
            "-1".to_string()
        } else {
            "0".to_string()
        });
        wt_args.push("new-tab".to_string());
        wt_args.push("-d".to_string());
        wt_args.push(path.to_string());
        wt_args.push("--title".to_string());
        wt_args.push(title.clone());

        let mut need_fallback = false;
        wt_args.push("--".to_string());
        wt_args.push(cmd_path);
        wt_args.push("/K".to_string());
        wt_args.push(cmd_payload.clone());

        match Command::new("wt").args(&wt_args).spawn() {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                need_fallback = true;
            }
            Err(_) => {
                need_fallback = true;
            }
        }

        if need_fallback {
            launch_cmd_console_payload(&path, &cmd_payload)?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // 先激活 Terminal 窗口，使其显示在最前面
        Command::new("osascript")
            .args(["-e", "tell app \"Terminal\" to activate"])
            .spawn()
            .map_err(|e| e.to_string())?;

        // 等待一小段时间确保 Terminal 被激活
        std::thread::sleep(std::time::Duration::from_millis(100));

        let escaped_path = escape_shell_single_quotes(&path);
        let escaped_title = escape_shell_single_quotes(&title);
        let title_script = format!("printf '\\e]0;{}\\a'", escaped_title);
        let shell_cmd_raw = if command.is_empty() {
            format!("cd '{}' && {}", escaped_path, title_script)
        } else {
            format!("cd '{}' && {} && {}", escaped_path, title_script, command)
        };
        let shell_cmd = escape_applescript_string(&shell_cmd_raw);

        let cmd = if open_in_new_window {
            format!("tell app \"Terminal\" to do script \"{}\"", shell_cmd)
        } else {
            format!(
                "tell app \"Terminal\"\nif (count of windows) is 0 then\n  do script \"{}\"\nelse\n  do script \"{}\" in window 1\nend if\nend tell",
                shell_cmd, shell_cmd
            )
        };

        Command::new("osascript")
            .args(["-e", &cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let _ = open_in_new_window;
        let escaped_title = title.replace('\'', "'\\''");
        let title_script = format!("printf '\\e]0;{}\\a'", escaped_title);
        let cmd = if command.is_empty() {
            format!(
                "x-terminal-emulator -e 'cd {} && {}; exec $SHELL'",
                path, title_script
            )
        } else {
            format!(
                "x-terminal-emulator -e 'cd {} && {} && {}; exec $SHELL'",
                path, title_script, command
            )
        };

        Command::new("sh")
            .args(["-c", &cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn open_directory(path: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err(format!("目录不存在或不是有效文件夹: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn adb_pair(address: &str, pairing_code: &str) -> Result<AdbCommandResult, String> {
    let address = require_non_empty(address, "配对地址")?;
    let pairing_code = require_non_empty(pairing_code, "配对码")?;

    run_adb_blocking(move || {
        let mut result = run_adb_process(&["pair", &address, &pairing_code])?;
        result.success = adb_pair_succeeded(&result);
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn adb_connect(address: &str) -> Result<AdbCommandResult, String> {
    let address = require_non_empty(address, "连接地址")?;

    run_adb_blocking(move || {
        let mut result = run_adb_process(&["connect", &address])?;
        result.success = adb_connect_succeeded(&result);
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn adb_list_devices() -> Result<AdbDevicesResult, String> {
    let result = run_adb_blocking(|| run_adb_process(&["devices"])).await?;
    let devices = parse_adb_devices(&result.stdout);
    let combined = format!("{}\n{}", result.stdout, result.stderr);

    Ok(AdbDevicesResult {
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        success: result.exit_code == Some(0) && !contains_adb_failure_text(&combined),
        devices,
    })
}

#[tauri::command]
fn set_global_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let next_shortcut = require_non_empty(&shortcut, "快捷键")?;
    let mut current_shortcut = state
        .0
        .lock()
        .map_err(|error| format!("读取快捷键状态失败: {error}"))?;
    let previous_shortcut = current_shortcut.clone();

    if previous_shortcut.as_deref() == Some(next_shortcut.as_str()) {
        return Ok(());
    }

    if let Some(previous) = previous_shortcut.as_deref() {
        app.global_shortcut()
            .unregister(previous)
            .map_err(|error| format!("卸载旧快捷键失败: {error}"))?;
    }

    if let Err(error) = register_global_shortcut(&app, &next_shortcut) {
        if let Some(previous) = previous_shortcut.as_deref() {
            register_global_shortcut(&app, previous)?;
        }
        return Err(error);
    }

    *current_shortcut = Some(next_shortcut);
    Ok(())
}

#[tauri::command]
fn clear_global_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalShortcutState>,
) -> Result<(), String> {
    let mut current_shortcut = state
        .0
        .lock()
        .map_err(|error| format!("读取快捷键状态失败: {error}"))?;

    if let Some(current) = current_shortcut.as_deref() {
        app.global_shortcut()
            .unregister(current)
            .map_err(|error| format!("清除快捷键失败: {error}"))?;
    }

    *current_shortcut = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ExitFlag(AtomicBool::new(false)))
        .manage(GlobalShortcutState(Mutex::new(None)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                // Keep the app out of the Dock; use tray/menu to control it.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            }

            let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("窗口图标缺失，无法创建托盘图标")?;

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        if let Some(flag) = app.try_state::<ExitFlag>() {
                            flag.0.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_main_window(&app);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let should_exit = window
                    .app_handle()
                    .state::<ExitFlag>()
                    .0
                    .load(Ordering::SeqCst);
                if !should_exit {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            jxlog_validate_runtime,
            jxlog_load_configuration,
            jxlog_save_configuration,
            jxlog_execute,
            open_terminal_and_run,
            open_directory,
            adb_pair,
            adb_connect,
            adb_list_devices,
            set_global_shortcut,
            clear_global_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ini_profiles_preserves_explicit_empty_path() {
        let profiles = parse_ini_profiles(
            r#"
[default]
source = portal
path =
"#,
        );

        assert_eq!(profiles[0].path, "");
    }

    #[test]
    fn parse_ini_profiles_defaults_missing_path() {
        let profiles = parse_ini_profiles(
            r#"
[default]
source = portal
"#,
        );

        assert_eq!(profiles[0].path, "gw_container");
    }

    #[test]
    fn parse_ini_profiles_reads_proxy() {
        let profiles = parse_ini_profiles(
            r#"
[default]
source = portal
proxy = http://127.0.0.1:7890
"#,
        );

        assert_eq!(profiles[0].proxy, "http://127.0.0.1:7890");
    }

    #[test]
    fn build_jxlog_portal_target_skips_empty_path() {
        let target = build_jxlog_portal_target("https://example.test/applog/", "", "st", &[], true);

        assert_eq!(target, "https://example.test/applog/st/");
    }

    #[test]
    fn build_jxlog_portal_target_places_host_before_path() {
        let target = build_jxlog_portal_target(
            "https://example.test/applog/",
            "gw_container",
            "st",
            &[],
            true,
        );

        assert_eq!(target, "https://example.test/applog/st/gw_container/");
    }

    #[test]
    fn build_jxlog_portal_target_omits_trailing_slash_for_file() {
        let target = build_jxlog_portal_target(
            "https://example.test/applog/",
            "gw_container",
            "st",
            &["jiaxin_gw_wechataccess", "jiaxin_gw_wechataccess.log"],
            false,
        );

        assert_eq!(
            target,
            "https://example.test/applog/st/gw_container/jiaxin_gw_wechataccess/jiaxin_gw_wechataccess.log"
        );
    }
}
