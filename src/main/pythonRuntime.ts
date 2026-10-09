/**
 * PythonRuntime — 统一的 Python 解释器探测与 agent-core 路径解析。
 *
 * 设计目标(修复 P1:内置 Python 运行环境 + 打包路径):
 *  1. 不再硬编码 `spawn("python")`;按优先级探测可用解释器:
 *       a. 环境变量 EASYCODE_PYTHON(用户/CI 显式指定)
 *       b. 随应用分发的内置解释器(resources/python/python.exe)
 *       c. userData/python(用户自行放置)
 *       d. 系统 PATH: python / py -3 / python3
 *  2. 解析 agent-core 目录,兼容开发态与打包态:
 *       - 开发态: <appPath>/agent-core
 *       - 打包态: <resourcesPath>/agent-core(通过 extraResources 打入)
 *  3. 提供诊断信息,便于设置界面/报错提示引导用户安装 Python。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface PythonCommand {
  /** 可执行文件路径(可能是 "python"/"py" 等命令名)。 */
  command: string;
  /** 需要预先传入的参数,如 ["-3"](py launcher)或 ["-m","pyright"]。 */
  args: string[];
  /** 来源描述,仅用于日志/诊断。 */
  source: string;
}

/** 校验一个解释器候选是否真的能运行。 */
function probe(command: string, args: string[]): boolean {
  try {
    const res = spawnSync(command, [...args, "--version"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5000,
    });
    return res.status === 0 && /python/i.test(`${res.stdout}${res.stderr}`);
  } catch {
    return false;
  }
}

/** 把候选加入结果列表(去重 + 校验)。 */
function tryCandidate(
  out: PythonCommand[],
  command: string | undefined | null,
  args: string[],
  source: string,
): void {
  if (!command) return;
  if (out.some((c) => c.command === command && c.args.join(" ") === args.join(" "))) return;
  if (probe(command, args)) out.push({ command, args, source });
}

/** 应用资源根目录(resources/),dev 与打包均可用的近似值。 */
function resourcesRoot(): string {
  // 打包态:process.resourcesPath 指向 resources/
  // 开发态:回退到项目根(appPath)
  return (process as unknown as { resourcesPath?: string }).resourcesPath || app.getAppPath();
}

/** 内置解释器可能存在的路径(Windows 用 python.exe)。 */
function bundledCandidates(): { path: string; source: string }[] {
  const exe = process.platform === "win32" ? "python.exe" : "python/bin/python3";
  const list: { path: string; source: string }[] = [
    { path: path.join(resourcesRoot(), "python", exe), source: "内置(resources)" },
    { path: path.join(app.getPath("userData"), "python", exe), source: "用户目录" },
  ];
  return list;
}

/** 解析出可用的 Python 命令,找不到返回 null。 */
export function resolvePython(): PythonCommand | null {
  const found: PythonCommand[] = [];

  // a. 显式环境变量(可以是解释器路径,也可能带参数,这里只取路径)
  tryCandidate(found, process.env.EASYCODE_PYTHON, [], "环境变量 EASYCODE_PYTHON");

  // b/c. 内置 / 用户目录解释器
  for (const c of bundledCandidates()) {
    if (fs.existsSync(c.path)) tryCandidate(found, c.path, [], c.source);
  }

  // d. 系统 PATH
  if (process.platform === "win32") {
    tryCandidate(found, "python", [], "系统 PATH");
    tryCandidate(found, "py", ["-3"], "系统 py launcher");
    tryCandidate(found, "python3", [], "系统 PATH");
  } else {
    tryCandidate(found, "python3", [], "系统 PATH");
    tryCandidate(found, "python", [], "系统 PATH");
  }

  return found[0] ?? null;
}

/** 诊断信息:供 UI 在找不到 Python 时给出可操作提示。 */
export function getPythonDiagnostics(): {
  available: boolean;
  source?: string;
  command?: string;
  searched: string[];
} {
  const resolved = resolvePython();
  const searched = [
    "EASYCODE_PYTHON 环境变量",
    ...bundledCandidates().map((c) => c.path),
    "系统 PATH(python / py -3 / python3)",
  ];
  return {
    available: !!resolved,
    source: resolved?.source,
    command: resolved?.command,
    searched,
  };
}

/**
 * 解析 agent-core 目录的绝对路径。
 *
 * - 打包态:resources/agent-core(extraResources 打入)
 * - 开发态:appPath/agent-core(源码目录)
 *
 * 返回 null 表示目录缺失(调用方应给出明确错误)。
 */
export function resolveAgentCoreDir(): string | null {
  const candidates = [
    path.join(resourcesRoot(), "agent-core"), // 打包态优先
    path.join(app.getAppPath(), "agent-core"), // 开发态
    path.join(process.cwd(), "agent-core"), // 兜底(从项目根启动)
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "main.py"))) return dir;
  }
  return null;
}
