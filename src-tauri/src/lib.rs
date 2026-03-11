use serde::Serialize;
use std::{io::ErrorKind, path::Path, process::Command};
use tauri_plugin_autostart::MacosLauncher;

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

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_terminal_and_run(path: &str, command: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Use cmd to start powershell. `/D path` sets the working directory for `start`.
        let mut args = vec!["/C", "start", "/D", path, "powershell", "-NoExit"];
        if !command.is_empty() {
            args.push("-Command");
            args.push(command);
        }
        
        Command::new("cmd")
            .args(&args)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    
    #[cfg(target_os = "macos")]
    {
        let cmd = if command.is_empty() {
            format!("tell app \"Terminal\" to do script \"cd '{}'\"", path)
        } else {
            format!("tell app \"Terminal\" to do script \"cd '{}' && {}\"", path, command)
        };
        
        Command::new("osascript")
            .args(["-e", &cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    
    #[cfg(target_os = "linux")]
    {
        let cmd = if command.is_empty() {
            format!("x-terminal-emulator -e 'cd {} && exec $SHELL'", path)
        } else {
            format!("x-terminal-emulator -e 'cd {} && {}; exec $SHELL'", path, command)
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
fn adb_pair(address: &str, pairing_code: &str) -> Result<AdbCommandResult, String> {
    let address = require_non_empty(address, "配对地址")?;
    let pairing_code = require_non_empty(pairing_code, "配对码")?;

    let mut result = run_adb_process(&["pair", &address, &pairing_code])?;
    result.success = adb_pair_succeeded(&result);
    Ok(result)
}

#[tauri::command]
fn adb_connect(address: &str) -> Result<AdbCommandResult, String> {
    let address = require_non_empty(address, "连接地址")?;

    let mut result = run_adb_process(&["connect", &address])?;
    result.success = adb_connect_succeeded(&result);
    Ok(result)
}

#[tauri::command]
fn adb_list_devices() -> Result<AdbDevicesResult, String> {
    let result = run_adb_process(&["devices"])?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_terminal_and_run,
            open_directory,
            adb_pair,
            adb_connect,
            adb_list_devices
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
