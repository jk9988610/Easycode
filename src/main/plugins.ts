import fs from "node:fs";
import path from "node:path";
import type { AppSettings } from "./settings";
import type { LanguageServerSpec } from "./languageServer";

export interface LanguageServerContribution {
  id: string;
  command: string;
  args?: string[];
  languages?: string[];
  workspaceFiles?: string[];
  missingWorkspaceFileMethod?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  contributes?: {
    activity?: string;
    commands?: { id: string; title: string }[];
    languageServers?: LanguageServerContribution[];
  };
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean;
  path: string;
  installed: boolean;
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
        const raw = JSON.parse(fs.readFileSync(pkg, "utf-8")) as PluginManifest;
        const id = raw.id || name;
        const enabled = this.settings.pluginsEnabled?.[id] !== false;
        this.plugins.push({
          ...raw,
          id,
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

  /**
   * Install by copying a folder that contains package.json into extensions/<id>.
   */
  installFromFolder(sourceDir: string): PluginInfo {
    const pkgPath = path.join(sourceDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      throw new Error("所选目录缺少 package.json，不是有效扩展");
    }
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PluginManifest;
    const id = raw.id || path.basename(sourceDir);
    if (!id || /[<>:"/\\|?*]/.test(id)) {
      throw new Error("扩展 id 无效");
    }
    const dest = path.join(this.root, id);
    if (path.resolve(sourceDir) === path.resolve(dest)) {
      this.scan();
      const existing = this.plugins.find((p) => p.id === id);
      if (existing) return existing;
    }
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDir(sourceDir, dest);
    this.scan();
    const installed = this.plugins.find((p) => p.id === id);
    if (!installed) throw new Error("安装后未能加载扩展");
    return installed;
  }

  uninstall(id: string): void {
    const dest = path.join(this.root, id);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    this.scan();
  }

  /**
   * Resolve language servers from enabled extensions, applying per-extension settings overrides.
   */
  resolveLanguageServers(): LanguageServerSpec[] {
    const out: LanguageServerSpec[] = [];
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
    return out;
  }
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
