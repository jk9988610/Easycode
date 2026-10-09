import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * 内置语言服务器定义。
 *
 * Easycode 不依赖扩展目录即可开箱支持 C/C++(clangd)、TypeScript/JavaScript
 * (typescript tsserver)、Python(pyright)。系统未安装对应二进制时自动跳过。
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { LanguageServerSpec } from "./languageServer";
import { resolvePython } from "./pythonRuntime";

/** 在 PATH 中查找可执行文件,找不到返回 null。 */
function which(bin: string): string | null {
  try {
    const out = execSync(`where ${bin}`, { encoding: "utf-8", windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const lines = out.trim().split(/\r?\n/);
    return lines[0] || null;
  } catch {
    return null;
  }
}

/** 找项目 node_modules 里的 typescript(回退到全局)。 */
function resolveTypeScriptPath(): string | null {
  // 从当前进程位置向上找 node_modules/typescript
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", "typescript", "lib", "tsserver.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 找 pyright-langserver(pip 安装的) */
function resolvePyrightPath(): string | null {
  // 先找 pyright-langserver 可执行
  const bin = which("pyright-langserver");
  if (bin) return bin;
  // 尝试 python -m pyright.langserver(复用统一的解释器探测)
  const python = resolvePython();
  if (!python) return null;
  try {
    const res = spawnSync(
      python.command,
      [...python.args, "-c", "import pyright"],
      { encoding: "utf-8", windowsHide: true, timeout: 8000, stdio: "ignore" },
    );
    if (res.status === 0) return python.command;
  } catch {
    /* ignore */
  }
  return null;
}

export function getBuiltinLanguageServers(): LanguageServerSpec[] {
  const specs: LanguageServerSpec[] = [];

  // --- clangd (C/C++) ---
  const clangd = which("clangd");
  if (clangd) {
    specs.push({
      id: "clangd",
      command: clangd,
      args: ["--background-index", "--clang-tidy", "--header-insertion=never"],
      languages: ["c", "cpp"],
      workspaceFiles: ["compile_commands.json"],
      missingWorkspaceFileMethod: "easycode/missingWorkspaceFile",
    });
  }

  // --- TypeScript / JavaScript (tsserver) ---
  const tsPath = resolveTypeScriptPath();
  if (tsPath) {
    const nodeBin = process.execPath; // Electron 的 node
    specs.push({
      id: "typescript-language-server",
      command: nodeBin,
      args: [tsPath, "--stdio"],
      languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    });
  }

  // --- Python (pyright) ---
  const pyright = resolvePyrightPath();
  if (pyright) {
    // 若返回的是 pyright-langserver 可执行本身,则直接 --stdio;
    // 否则(走 python -m)需要追加模块名。
    const isLangServerBin = /pyright-langserver(\.cmd|\.exe)?$/i.test(pyright);
    specs.push({
      id: "pyright",
      command: pyright,
      args: isLangServerBin ? ["--stdio"] : ["-m", "pyright.langserver", "--stdio"],
      languages: ["python"],
    });
  }

  return specs;
}
