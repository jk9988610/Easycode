# Easycode

个人用编辑器：Electron + Monaco，扩展可安装；语言能力（如 clangd）由扩展贡献，**不是**编辑器内置环境。

## 环境

- Node 18+ / npm
- Python 3.10+（Compare 扩展）
- 若使用 clangd 扩展：本机 PATH 上有 `clangd`，或在设置里填写 `extensionSettings.clangd.command`

## 安装与运行

```bash
cd E:\tools\Easycode
npm install
npm run dev
```

## 扩展模型（对齐 VS Code 思路）

- 核心：壳、文件树、Monaco、**通用 LSP 客户端**、扩展加载
- `extensions/<id>/package.json` 可贡献 `languageServers` / 命令 / 活动栏
- **从文件夹安装**：扩展面板 →「从文件夹安装…」，或菜单「扩展」
- 自带示例扩展：
  - `clangd`：贡献 languageServer（可禁用/卸载）
  - `compare`：目录比对工具扩展

## 布局与终端

- 顶栏按钮：切换左侧栏 / 底栏 / 右侧栏
- 终端：PowerShell、CMD、Git Bash（底栏面板；快捷键 Ctrl+J / Ctrl+\`）
- 设置勾选项：自动保存、自动识别语言、自动识别编码


编辑器不解析 `.uvprojx`。clangd 扩展会提示缺少 `compile_commands.json`。

## 设置

Electron `userData/settings.json`（或 `~/.easycode/settings.json`）：

- 编辑器：字号、字体、换行、上次工作区
- Compare：`pythonPath`、`compareRoot`
- 扩展启停：`pluginsEnabled`
- 扩展参数：`extensionSettings.clangd.command` 等
