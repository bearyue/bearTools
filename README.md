# bearTools

## 框架选型（第一阶段结论）

### 推荐方案：**Tauri 2 + React + TypeScript + TailwindCSS + shadcn/ui**

这是针对你的目标（mac/win 双端、界面优美、高扩展性、本地命令能力）最均衡的一套：

- **跨平台桌面**：Tauri 原生支持 macOS / Windows（后续也可扩 Linux）。
- **本地能力强**：通过 Tauri Rust 后端可安全执行本地命令（如 `adb`、终端脚本等）。
- **界面美观且效率高**：React 生态 + Tailwind + shadcn/ui，能快速做出现代化界面。
- **体积与性能更优**：相对 Electron，Tauri 包体更小、内存占用通常更低。
- **高扩展性**：可采用“工具插件化”架构，每个工具独立注册、独立视图、独立能力声明。

---

## 为什么不优先 Electron / Flutter

- **Electron**：生态成熟，但资源占用偏高；你目前目标偏“私人高效工具箱”，Tauri 更轻。
- **Flutter Desktop**：UI 很强，但前端生态（Web 工具类、组件库、插件市场）对你这个场景不如 React 直接。

---

## 建议的项目结构（可直接按此开工）

```txt
bearTools/
  src/                         # React 前端
    app/
    pages/
    components/
    tools/                     # 每个工具一个目录（插件化）
      adb/
      url-encode/
  src-tauri/                   # Tauri + Rust
    src/
      commands/                # 对前端暴露的本地命令接口
      tools/                   # 工具后端能力封装（adb、shell 等）
```

---

## 首批工具落地建议

### 1) 本地命令调用（adb / 终端）

- 前端提供“命令模板 + 参数输入 + 输出面板”。
- 后端通过白名单命令执行：
  - 例如只允许 `adb`、`git`、`python` 等指定命令。
- 支持：
  - 标准输出/错误流展示；
  - 历史命令记录；
  - 一键复制结果。

### 2) 简单工具（URL 编码/解码）

- 这类逻辑可先在前端本地完成（即时响应）。
- 后续可统一包装为“工具插件”，保持一致的 UI 和配置方式。

---

## 扩展性设计要点

- 定义统一 `ToolManifest`：
  - `id` / `name` / `category` / `permissions` / `entryComponent`。
- 前端根据 manifest 自动生成侧边栏和工具路由。
- 后端按权限能力分层：
  - `shell.exec`、`fs.read`、`network.http` 等。
- 默认最小权限原则：工具只拿到声明过的能力。

---

## 下一步（你确认后我可以继续细化）

1. 初始化脚手架（Tauri 2 + React + TS + Tailwind + shadcn/ui）。
2. 落地插件注册机制（先实现 `adb` 与 `url-encode` 两个工具插件）。
3. 做第一版 UI（左侧工具栏 + 右侧工作区 + 命令输出面板）。
