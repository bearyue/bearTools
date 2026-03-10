# bearTools 🐻

一个专为开发者打造的现代化跨平台桌面工具箱。采用“多实例标签页”架构，支持工具无损后台保活，体验顺滑如原生。

![Architecture](https://img.shields.io/badge/Architecture-Tauri%202.0-blue) ![Frontend](https://img.shields.io/badge/Frontend-React%2019%20+%20Tailwind%20V4-61DAFB) ![Language](https://img.shields.io/badge/Language-TypeScript%20+%20Rust-orange)

---

## 🏗️ 核心架构与 UI 设计

本项目在 UI/UX 层面采用了 **浏览器级多标签页 (Multi-Tab)** 架构，设计逻辑如下：

1. **配置化工具注册**：
   - 所有工具模块均在 `src/App.tsx` 中的 `INITIAL_TOOLS` 数组内统一注册。
   - 左侧菜单动态读取配置，**支持拖拽排序**。
2. **工具专属上下文 (Tool-Scoped Context)**：
   - 点击左侧菜单**不会**直接打开新页面，而是切换“工具大类上下文”。
   - 顶部标签栏显示的是当前工具下所有**已实例化的 Tab**。
3. **多实例与后台保活 (State Preservation)**：
   - 支持同一工具开启多个实例（如：`URL 编解码 1`，`URL 编解码 2`）。
   - **核心机制**：切换标签页或切换左侧工具大类时，被隐藏的 Tab **不会被卸载 (Unmount)**，而是通过 `display: none` (`hidden` Tailwind 类) 在后台保活。所有未保存的文本、滚动条位置、网络请求状态均会完美保留。

---

## 🚀 已完成功能 (Phase 1)

- [x] **基础框架搭建**：基于 Tauri 2.0 + React 19 + TypeScript + TailwindCSS v4。
- [x] **现代化 UI 骨架**：
  - 左侧边栏 (工具列表) + 右侧工作区 (多标签管理 + 独立工具组件)。
  - 极细边框、柔和阴影、类 SaaS 仪表盘质感。
- [x] **左侧菜单拖拽排序**：基于 `@dnd-kit` 实现。
- [x] **顶部 Tab 高级管理**：
  - 支持 `+` 按钮新建当前工具实例。
  - 支持跨行水平拖拽排序 (`rectSortingStrategy`)。
  - 支持右键菜单：关闭其他、关闭所有。
  - **无缝状态保活**：隐藏 Tab 状态不丢失。
- [x] **工具 UI 占位**：已画好 `ADB WiFi 配对` 和 `URL 编解码` 的第一版静态 UI，包含控制台输出模拟区域。
- [x] **Agent 启动工具**：支持目录/指令/分组管理，可一键打开终端并执行预设指令。
- [x] **ADB WiFi 配对工具**：
  - 支持 `adb devices` 检查、`adb pair` / `adb connect` 向导式流程。
  - 支持分段 IP/Port 输入、6 位配对码输入、连接结果复核与控制台输出。
- [x] **URL 编解码工具**：
  - 支持上下结构输入/结果区、手动 Encode/Decode、复制结果、清空输入。
- [x] **Unix 时间戳工具**：
  - 支持当前时间戳开始/停止/刷新。
  - 支持秒/毫秒切换、时间戳与日期时间双向转换。

---

## 🛠️ 后续开发规划 (Phase 2 & 3)

### Phase 2: 工具核心功能实现
1. **URL 编解码工具 (纯前端)**：
   - [x] 已完成 Encode/Decode、结果复制、输入清空与响应式布局优化。
2. **ADB WiFi 配对工具 (Rust 桥接)**：
   - [x] 已完成 `adb devices`、`adb pair`、`adb connect` 桥接与前端向导式交互。
3. **Unix 时间戳工具 (纯前端)**：
   - [x] 已完成当前时间戳展示、秒/毫秒切换与常用时间转换。

### Phase 3: 工程化与架构升级
1. **组件拆分**：随着工具增加，目前的 `App.tsx` 体积会膨胀。需将 `AdbTool`、`UrlTool` 以及 `SortableTab` 拆分到独立的组件文件中（如 `src/tools/adb/index.tsx`）。`AgentLauncher` 已先行拆分到 `src/components/AgentLauncher.tsx`。
2. **状态持久化**：将 `instances` (已打开的标签页) 和 `tools` (左侧排序结果) 同步到 `localStorage` 或 Tauri Store 中，实现重启后恢复上次工作状态。
3. **新工具扩充**：JSON 格式化、时间戳转换、Base64 加解密等常用工具。

---

## ⚠️ 开发注意事项 (给 AI 代理的 Prompt)

1. **Tab 保活原则**：在拆分组件或重构时，**严禁**使用条件渲染 `{activeTab === id && <Tool />}` 来切换 Tab，这会导致组件销毁！必须继续沿用 `className={isActive ? 'block' : 'hidden'}` 的 CSS 控制方案。
2. **Tauri 通信**：调用底层能力时，请在 `src-tauri/tauri.conf.json` 中配置好对应的权限 (Capabilities)，且 Tauri 2.0 中 IPC 调用语法为 `@tauri-apps/api/core` 中的 `invoke`。
3. **Tailwind V4**：本项目使用 TailwindCSS v4，不再需要 `tailwind.config.js`，全局配置和主题变量写在 `src/index.css` 的 `@theme` 中。

---

## 💻 本地运行

```bash
# 安装依赖
npm install

# 启动桌面端开发服务
npm run tauri dev

# 打包发布 (Windows -> .exe / .msi)
npm run tauri build
```
