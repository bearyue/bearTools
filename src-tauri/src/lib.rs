use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri::async_runtime::spawn_blocking;
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
fn require_non_empty(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name}不能为空"));
    }

    Ok(trimmed.to_string())
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
        stdout: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim_end().to_string(),
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
    let has_success_phrase = lower.contains("connected to") || lower.contains("already connected to");

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
        let candidate = format!(
            "{}\\System32\\cmd.exe",
            system_root.trim_end_matches('\\')
        );
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
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_terminal_and_run(
    request: OpenTerminalRequest,
) -> Result<(), String> {
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
        wt_args.push(if open_in_new_window { "-1".to_string() } else { "0".to_string() });
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
            format!("x-terminal-emulator -e 'cd {} && {}; exec $SHELL'", path, title_script)
        } else {
            format!("x-terminal-emulator -e 'cd {} && {} && {}; exec $SHELL'", path, title_script, command)
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
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
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
                app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
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
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
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
                    }
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








