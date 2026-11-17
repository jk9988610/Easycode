# EasyCode 项目现状总结

## 一、项目定位

**EasyCode** —— 基于 Electron + Monaco 的桌面代码编辑器，仿 VS Code 界面，内置可自举的 AI Agent。核心卖点是 **Agent 能改自己**：既能改业务代码，也能改自身代码，并自动验证、可回滚。

- **GitHub**: https://github.com/jk9988610/Easycode
- **版本**: `0.2.0`（package.json）
---

## 二、技术栈

| 层 | 技术 |
|---|---|
| 壳 | Electron 33.2.1 + electron-builder 26 |
| 渲染 | Vite 6 + TypeScript 7 + Monaco Editor 0.56 |
| 主进程 | Node + esbuild 编译 |
| 终端 | @xterm/xterm + node-pty（换成 `@homebridge/node-pty-prebuilt-multiarch`） |
| LSP | 自研 lspBridge + clangd/ts/pyright |
| Agent 内核 | Python 3（DeepSeek API + 自研 tool loop） |
| 打包 | `npm run dev`（日常）/ `npm run dist:win`（发布，未跑通） |

---

## 三、目录结构（关键部分）

```
agent-core/                  Agent 内核（Python）
  agent_loop.py    246 行    工具循环 + 交互模式 + system prompt
  tools.py         111 行    5 个工具的 JSON Schema
  executor.py      156 行    工具执行（路径围栏 / 编码兜底 / 危险命令拦截）
  deepseek_client.py 41 行   API 封装
  main.py          40 行     CLI 入口（--interactive）

src/main/                   主进程（ESM）
  index.ts         601 行    应用入口 + IPC 注册
  agentHost.ts     358 行    Agent 子进程 + checkpoint + py_compile 校验 + rollback
  sessionStore.ts   70 行    会话持久化（JSON 落盘，已就绪但 renderer 未用）
  git.ts           184 行    12 个 git 命令封装
  terminal.ts      178 行    终端 PTY
  languageServer.ts 200 行   LSP 客户端
  plugins.ts       259 行    扩展宿主
  extensionHost.ts 249 行    扩展执行环境
  builtinServers.ts 105 行   内置 LSP 服务器发现
  fileWatcher.ts   211 行    文件监听
  settings.ts      122 行    设置持久化
  vscodeApi.ts     418 行    扩展 vscode API 垫片

src/renderer/               渲染进程
  main.ts         2693 行   主 UI（tab / explorer / chat / scm / 命令面板 / 设置）
  styles.css      2234 行   所有样式
  lspBridge.ts     517 行   LSP 前端桥
  sourceControl.ts 203 行   SCM 面板
  terminalPanel.ts 174 行   终端视图
  monacoSetup.ts    70 行   Monaco worker / 主题
  types.ts         264 行   共享类型

devtool.py                AI 开发辅助工具（Tkinter GUI）
help.txt                  devtool 帮助说明
Agent-core.md             项目背景文档
updateplan.md             历史规划笔记
```

---

## 四、已实现功能清单

### 🎨 编辑器 UI
- ✅ 活动栏（资源管理器 / 搜索 / SCM / 扩展 / 账户 / 设置）
- ✅ 文件树（展开/折叠/新建）
- ✅ 多标签编辑器（Monaco）
- ✅ 面包屑、状态栏、问题面板、输出面板
- ✅ 命令面板（Ctrl+Shift+P）
- ✅ 设置弹窗
- ✅ 深色主题（GitHub 黑）
- ✅ **可拖拽 sidebar（160–600px）+ rightbar（160–600px）**，宽度持久化
- ✅ **Monaco overview ruler 三色标记**（新增绿 / 修改蓝 / 删除红）
- ✅ **tab 上的 git 标记**（M/A/U/D/R，彩色）
- ✅ **资源管理器文件的 git 标记**（同上）

### 🔧 编辑能力
- ✅ Monaco 编辑 + 语法高亮（多语言）
- ✅ 文件读写 + 编码检测（UTF-8/GBK）
- ✅ 文件监听 + 外部修改同步
- ✅ 自动保存、Word wrap、字体设置

### 🖥️ 终端
- ✅ xterm 终端（PowerShell / cmd / Git Bash）
- ✅ 多终端切换（侧栏 tab）
- ✅ `useConpty` 检查（Windows）

### 🔌 LSP
- ✅ 内置 C/C++（clangd）、TS/JS、Python（pyright）
- ✅ 诊断 → 问题面板
- ✅ 跳转定义、悬停、补全

### 📦 扩展
- ✅ 本地 `.vsix` / 文件夹安装
- ✅ 扩展宿主 + vscode API 垫片
- ✅ 状态栏、输出通道、命令注册

### 🌿 Git 集成
- ✅ SCM 面板：status / stage / unstage / commit / diff
- ✅ diff 以 tab 形式打开（Monaco DiffEditor）
- ✅ tab / explorer / ruler 三层可视化标记

### 🤖 Agent（核心）
- ✅ 交互模式（长对话，子进程常驻）
- ✅ 5 个工具：`read_file` / `write_file` / `edit_file` / `list_dir` / `run_command`
- ✅ **edit_file 支持 LF/CRLF 跨换行匹配**（按文件风格自动重试）
- ✅ 事件流 JSONL（thinking / tool_call / tool_result / final）
- ✅ **每轮开始前自动 git stash 检查点**（Step 1）
- ✅ **改 `agent-core/*.py` 后自动 `py_compile` 校验**（Step 2）
- ✅ **聊天底部"回滚本轮"按钮**（Step 3）
- ✅ **system prompt 强制"改完必须验证"**（Step 2 延伸）
- ✅ 聊天面板实时显示思考 / 工具调用 / 结果 / 验证状态
- ✅ **会话持久化**：启动恢复 + 消息 500ms 防抖落盘（`sessionStore.ts` + `window.easycode.*Session`）
- ✅ **Chat 多会话 UI**：历史下拉框 + 新建对话，header 固定不随消息滚动
- ✅ **上下文注入**：Ctrl+L / 右键「添加到对话」把选中代码加为附件
- ✅ **整组折叠**：thinking / 工具调用 / 工具结果折成一条「已完成 N 步 · 用时 Xs」摘要
- ✅ **工具调用文件链接**：工具参数里的路径可点击，直接打开编辑器
- ✅ **检查点修复**：stash push 后立即 apply，未跟踪文件不再被卷走

### 💬 Chat 增强
- ✅ markdown 渲染（标题 / 列表 / 粗斜体 / 行内代码 / 代码块）
- ✅ 思考 / 工具调用整组折叠（「已完成 N 步 · 用时 Xs」）
- ✅ 工具调用文件链接（可点击打开编辑器）
- ✅ 多会话 UI（历史下拉 + 新建对话）
- ✅ 会话持久化（消息 500ms 防抖落盘，重启恢复）
- ✅ 上下文附件（Ctrl+L / 右键菜单，累积多段，发送后清空）

### 💾 工作区状态
- ✅ 打开的标签页持久化（关闭/重开自动恢复）
- ✅ 光标位置持久化
- ✅ 按工作区区分（切换文件夹不影响）

### 🛠️ devtool.py（AI 开发辅助）
- ✅ 三 tab：文件操作 / Patch & Commit / 帮助
- ✅ 文件操作 JSON：`write` / `append` / `delete` / `mkdir` / `shell`
- ✅ **⚡ 一键运行**：写文件 → 切 tab → 选脚本 → 跑 patch → 复制输出
- ✅ Patch & Commit：跑 patch、typecheck、git 提交
- ✅ 深色主题
- ✅ **自动探测 node.exe**：NODE_EXE → PATH → 常见路径 → 注册表

---

## 五、待办 / 已知问题

| 优先级 | 项目 | 状态 |
|---|---|---|
| 🟠 | **正式打包**：`electron-builder` 需代理下载 NSIS 二进制 | 未跑通 |
| 🟠 | **资源管理器右键菜单**：新建 / 重命名 / 删除 / 在终端打开 | 未开始 |
| 🟡 | **文件拖拽到聊天框**：拖文件 / 文件夹 → 加为上下文附件 | 未开始 |
| 🟡 | **聊天输入框草稿持久化**：未发出的内容也记住（区别于聊天记录持久化） | 未开始 |
| 🟡 | **聊天文件标签增强**：标签可点击打开 + 简单 diff 摘要（+N -M） | 未开始 |
| 🟡 | **上下文注入优化**：无选中时不带「当前文件」；加「最近 Agent 编辑过」提示 | 未开始 |
| 🟡 | **Diff 预览**：Agent 改文件前先弹 diff 让用户确认 | 未开始 |
| 🟡 | **Agent 工具扩展**：`glob` / `search`（正则内容搜索）/ `multi_edit` | 未开始 |
| 🟢 | **`AGENTS.md`**：面向接手 AI 的约定文件 | 未创建 |
| 🟢 | **文件搜索**：活动栏「搜索」图标仍为占位 | 未开始 |
| 🟢 | **命令面板增强**：目前只有几个命令 | 未开始 |

---

## 六、关键约定（给接手者）

1. **源文件多为 CRLF** —— patch 脚本处理时用 `\r` 感知或按行 split，勿用多行字符串匹配
2. **不要用 PowerShell `Set-Content` 改源码** —— 会把 UTF-8 中文写坏，用 devtool 或 Node 脚本
3. **patch 脚本命名必须 `patch-*.py`**（优先）或 `patch-*.cjs`，才会出现在 devtool 下拉里
4. **patch 脚本必须幂等** —— 先检测锚点是否存在，已存在就跳过
5. **开发用 `npm run dev`** —— 不经过 electron-builder，无打包依赖问题
6. **renderer 改动 Vite 热更，主进程改动需重启 dev**
7. **⚠️ 在 EasyCode 里用 chat 前，先 commit 未提交的 devtool 改动** —— Agent 每次启动会 `git stash push` 做检查点，未提交改动会被 stash 走（从编辑器里"消失"）。发现改动丢失时：`git stash list` 找，然后 `git checkout stash@{0} -- <文件>` 恢复

---
