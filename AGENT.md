# bearTools 开发指南（给 Agent）

## 项目速览
- 桌面端：Tauri 2.0
- 前端：React 19 + TypeScript + Tailwind CSS v4
- 架构：左侧工具列表 + 右侧工作区，多工具标签页

## 关键约束（非常重要）
- **Tab 保活原则**：不要用条件渲染卸载组件（例如 `{active && <Tool/>}`）。必须用 `display`/`hidden` 保持组件挂载，保证状态不丢。
- **Tauri 调用**：前端使用 `@tauri-apps/api/core` 的 `invoke`。
- **Tailwind v4**：全局主题在 `src/index.css` 的 `@theme`，不要依赖 `tailwind.config.js`。

## 结构与入口
- 工具注册：`src/App.tsx` 中 `INITIAL_TOOLS`
- ADB 工具：`src/App.tsx` 内的 `AdbTool`（后续可拆分）
- Agent 启动器：`src/components/AgentLauncher.tsx`
- Tauri 命令：`src-tauri/src/lib.rs`

## ADB 工具注意点
- ADB 检测为**手动触发**，进入工具不会自动检查。
- Rust 侧 ADB 命令已使用后台线程（`spawn_blocking`），避免 UI 阻塞。

## 本地运行
```bash
npm install
npm run tauri dev
npm run tauri build
```

