import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import type { AppSettings } from "./settings";
import type { LanguageServerSpec } from "./languageServer";
import { getBuiltinLanguageServers } from "./builtinServers";

export interface LanguageServerContribution {
  id: string;
  command: string;
  args?: string[];
  languages?: string[];
  workspaceFiles?: string[];
  missingWorkspaceFileMethod?: string;
}

/** Compatible with VS Code / Open VSX package.json (+ optional Easycode languageServers). */
export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  publisher?: string;
  contributes?: {
    activity?: string;
    commands?: { command?: string; id?: string; title: string }[];
    languageServers?: LanguageServerContribution[];
    languages?: unknown[];
    themes?: unknown[];
    grammars?: unknown[];
    configuration?: {
      title?: string;
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
    views?: unknown;
    viewsContainers?: unknown;
  };
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean;
  path: string;
  installed: boolean;
}

type RawPackage = {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  publisher?: string;
  contributes?: PluginManifest["contributes"];
};

function normalizeManifest(raw: RawPackage, fallbackName: string): PluginManifest {
  const pkgName = raw.name || fallbackName;
  const publisher = raw.publisher || "local";
  const id = raw.id || `${publisher}.${pkgName}`;
  return {
    id,
    name: raw.displayName || raw.name || id,
    description: raw.description,
    version: raw.version,
    publisher,
    contributes: raw.contributes,
  };
}

function safeExtDirName(id: string): string {
  return id.replace(/[<>:"/\\|?*]/g, "_");
}

export class PluginHost {
  private root: string;
  private settings: AppSettings;
  private plugins: PluginInfo[] = [];

  constructor(extensionsRoot: string, settings: AppSettings) {
    this.root = extensionsRoot;
    this.settings = settings;
    fs.mkdirSync(this.root, { recursive: true });
    this.scan();
  }

  get extensionsRoot(): string {
    return this.root;
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  scan(): void {
    this.plugins = [];
    if (!fs.existsSync(this.root)) return;
    for (const name of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const pkg = path.join(dir, "package.json");
      if (!fs.existsSync(pkg)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(pkg, "utf-8")) as RawPackage;
        const manifest = normalizeManifest(raw, name);
        const enabled = this.settings.pluginsEnabled?.[manifest.id] !== false;
        this.plugins.push({
          ...manifest,
          enabled,
          path: dir,
          installed: true,
        });
      } catch (err) {
        console.error("plugin load failed", name, err);
      }
    }
  }

  list(): PluginInfo[] {
    this.scan();
    return this.plugins;
  }

  get(id: string): PluginInfo | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Install from a folder containing package.json (or extension/package.json). */
  installFromFolder(sourceDir: string): PluginInfo {
    const pkgDir = resolvePackageDir(sourceDir);
    const pkgPath = path.join(pkgDir, "package.json");
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as RawPackage;
    const manifest = normalizeManifest(raw, path.basename(pkgDir));
    return this.installPackageDir(pkgDir, manifest);
  }

  /** Install from a .vsix (ZIP) — same format as VS Code / Open VSX. */
  installFromVsix(vsixPath: string): PluginInfo {
    if (!fs.existsSync(vsixPath)) {
      throw new Error("找不到 VSIX 文件");
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "easycode-vsix-"));
    try {
      const zip = new AdmZip(vsixPath);
      zip.extractAllTo(tmp, true);
      const pkgDir = resolvePackageDir(tmp);
      const raw = JSON.parse(
        fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"),
      ) as RawPackage;
      const manifest = normalizeManifest(raw, path.basename(vsixPath, ".vsix"));
      return this.installPackageDir(pkgDir, manifest);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  uninstall(id: string): void {
    const plugin = this.list().find((p) => p.id === id);
    const dest = plugin?.path || path.join(this.root, safeExtDirName(id));
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    this.scan();
  }

  resolveLanguageServers(): LanguageServerSpec[] {
    const out: LanguageServerSpec[] = [];

    // 1. 扩展贡献的语言服务器
    for (const plugin of this.list()) {
      if (!plugin.enabled) continue;
      const servers = plugin.contributes?.languageServers || [];
      for (const s of servers) {
        const override = this.settings.extensionSettings?.[plugin.id] || {};
        out.push({
          id: s.id || plugin.id,
          command: String(override.command || s.command),
          args: (override.args as string[] | undefined) || s.args || [],
          languages: s.languages || [],
          workspaceFiles: s.workspaceFiles || [],
          missingWorkspaceFileMethod: s.missingWorkspaceFileMethod,
        });
      }
    }

    // 2. 内置语言服务器(clangd / tsserver / pyright)— 扩展未覆盖的语言才追加
    const extLangs = new Set(out.flatMap((s) => s.languages || []));
    for (const spec of getBuiltinLanguageServers()) {
      const hasOverlap = (spec.languages || []).some((l) => extLangs.has(l));
      if (!hasOverlap) out.push(spec);
    }

    return out;
  }

  private installPackageDir(pkgDir: string, manifest: PluginManifest): PluginInfo {
    if (!manifest.id?.trim()) {
      throw new Error("扩展 id 无效");
    }
    const dirName = safeExtDirName(manifest.id);
    const dest = path.join(this.root, dirName);
    if (path.resolve(pkgDir) === path.resolve(dest)) {
      this.scan();
      const existing = this.plugins.find((p) => p.id === manifest.id);
      if (existing) return existing;
    }
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDir(pkgDir, dest);
    // Ensure package.json has a stable id for future scans
    const destPkg = path.join(dest, "package.json");
    try {
      const raw = JSON.parse(fs.readFileSync(destPkg, "utf-8")) as RawPackage;
      if (!raw.id) {
        raw.id = manifest.id;
        if (!raw.publisher && manifest.publisher) raw.publisher = manifest.publisher;
        fs.writeFileSync(destPkg, JSON.stringify(raw, null, 2) + "\n", "utf-8");
      }
    } catch {
      /* keep as-is */
    }
    this.scan();
    const installed = this.plugins.find((p) => p.id === manifest.id);
    if (!installed) throw new Error("安装后未能加载扩展");
    return installed;
  }
}

function resolvePackageDir(root: string): string {
  const direct = path.join(root, "package.json");
  if (fs.existsSync(direct)) return root;
  const nested = path.join(root, "extension", "package.json");
  if (fs.existsSync(nested)) return path.join(root, "extension");
  throw new Error("未找到 package.json（需要扩展根目录或 VSIX 内的 extension/）");
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === "node_modules" || name === ".git") continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}
