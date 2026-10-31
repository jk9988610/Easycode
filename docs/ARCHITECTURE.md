# Easycode 架构

## 三层结构

| 层 | 目录 | 技术 | 入口 |
|---|---|---|---|
| 主进程 | `src/main/` | Electron (ESM, esbuild) | `index.ts` |
| 渲染进程 | `src/renderer/` | Vite + Monaco | `main.ts` |
| Agent 内核 | `agent-core/` | Python (DeepSeek tool loop) | `main.py` |

## 数据流

    renderer (main.ts)
      └─ IPC ─→ main/index.ts
                  ├─ agentHost.ts ──→ python main.py --interactive
                  │                     └─ agent_loop.py → executor.py → tools.py
                  ├─ languageServer.ts ─→ LSP (vscode-jsonrpc)
                  └─ terminal.ts ──────→ node-pty
    ↑ JSONL 事件流（每行一个 {type,...}）

## 关键文件

- `src/renderer/main.ts` (~3074 行) — 编辑器 UI 总入口，**待拆分**
- `src/main/index.ts` (~705 行) — 主进程总入口
- `src/main/agentHost.ts` — Agent 子进程生命周期 + 事件转发
- `src/main/languageServer.ts` — LSP 客户端
- `src/main/extensionHost.ts` + `vscodeApi.ts` — 最小 VS Code 扩展宿主
- `agent-core/agent_loop.py` (~754 行) — 模型-工具主循环
- `agent-core/executor.py` (~748 行) — 工具执行器

## 开发

- 开发：`npm run dev`（vite + electron + watch）
- 打包：`npm run dist`（**日常不要跑**）
- 类型检查：`npm run typecheck`
- 开发辅助：`devtool.py`（Tkinter，3 tab：文件操作 / Patch&Commit / 帮助）

## 已知痛点（2026-10 快照）

1. `.bak` + `.easycode/{lastgood,pending}` 双快照当版本控制（36.5MB）→ 应用 git 替代
2. `main.ts` 3074 / `index.ts` 705 / `agent_loop.py` 754 / `executor.py` 748 行 → 需拆分
3. 无 `tests/`、`e2e/`、CI → 无回归保护
4. `builtinServers.ts` 语言服务硬编码 → 可抽 `languages/*.toml` 声明式（参考 openidea）

## 参考项目

`E:\tools\openidea-main`（Rust/Tauri IDE）：声明式语言配置、插件契约、CI、e2e、perf 骨架可作工程层参考。
