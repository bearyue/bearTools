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
        
        std::process::Command::new("cmd")
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
        
        std::process::Command::new("osascript")
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
        
        std::process::Command::new("sh")
            .args(["-c", &cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, open_terminal_and_run])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
