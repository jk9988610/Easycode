import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface CompareOptions {
  pythonPath: string;
  compareRoot: string;
  ignoreWhitespace: boolean;
}

export async function runCompare(
  dirA: string,
  dirB: string,
  opts: CompareOptions,
): Promise<unknown> {
  const script = path.join(opts.compareRoot, "engine_cli.py");
  if (!fs.existsSync(script)) {
    return {
      error: `找不到 engine_cli.py: ${script}。请确认 compareRoot 设置。`,
      changes: [],
    };
  }

  const args = [script, dirA, dirB];
  if (opts.ignoreWhitespace) args.push("--ignore-whitespace");

  return new Promise((resolve) => {
    const proc = spawn(opts.pythonPath, args, {
      cwd: opts.compareRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    proc.on("close", (code) => {
      if (!stdout.trim()) {
        resolve({
          error: stderr.trim() || `compare 退出码 ${code}`,
          changes: [],
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({
          error: `无法解析 compare JSON: ${stderr || stdout.slice(0, 200)}`,
          changes: [],
        });
      }
    });
  });
}
