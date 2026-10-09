# Easycode





干净的桌面代码编辑器壳：Electron + Monaco，布局对齐 VS Code。  
**不预装**语言服务或第三方工具扩展。

## 环境

- Node 18+ / npm

## 安装与运行

```bash
cd E:\tools\Easycode
npm install
npm run dev
```

## 布局

- 顶栏：菜单、AI/帐户占位、布局开关、窗控
- 活动栏：资源管理器 / 搜索(占位) / SCM(占位) / 扩展；底部帐户与设置
- 编辑区：标签、面包屑、Monaco
- 底栏：问题 / 输出(占位) / 调试(占位) / 终端
- 右侧：大纲(占位) / 文件信息 / 聊天(占位)
- 状态栏：问题计数、路径、行列、语言、编码、EOL 等

## 扩展（本地安装）

使用与 VS Code / Open VSX 相同的包格式，**不连接市场**：

- 从 `.vsix` 安装，或从含 `package.json` 的扩展文件夹安装
- 安装目录：Electron `userData/extensions`
- 可在扩展视图中启用 / 禁用 / 卸载

内置**最小扩展宿主**：可加载扩展 `main` 入口，并实现常用 `vscode` API 子集（状态栏、命令、输出通道、终端、工作区配置）。例如 Keil Bar 可在底栏显示编译/烧录等按钮。完整 VS Code 扩展 API 尚未覆盖。

若扩展声明了 `contributes.languageServers`，也会用于启动语言服务。

## 设置

保存在 Electron `userData/settings.json`（或 `~/.easycode/settings.json`）：字号、字体、换行、自动保存、布局显隐、底栏高度与视图等。
