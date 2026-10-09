import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import type { PluginInfo } from "./plugins";
import type { TerminalHost, ShellKind } from "./terminal";
import {
  VscodeApiFactory,
  type VscodeHostBridge,
  type StatusBarItemState,
  type OutputChannelState,
  type ExtMessage,
  type ExtTerminalEvent,
} from "./vscodeApi";

export type { StatusBarItemState, OutputChannelState, ExtMessage, ExtTerminalEvent };

interface LoadedExtension {
  id: string;
  path: string;
  deactivate?: () => void | Promise<void>;
  subscriptions: { dispose(): void }[];
}

/**
 * Minimal VS Code-compatible extension host.
 * Loads enabled extensions' main entry and provides a small `vscode` shim
 * (status bar, commands, output channel, terminal, workspace config).
 */
export class ExtensionHost {
  private bridge: VscodeHostBridge;
  private apiFactory: VscodeApiFactory;
  private loaded: LoadedExtension[] = [];
  private hookInstalled = false;
  private configDefaults: Record<string, unknown> = {};
  private api: ReturnType<VscodeApiFactory["createApi"]> | null = null;

  constructor(bridge: VscodeHostBridge) {
    this.bridge = bridge;
    this.apiFactory = new VscodeApiFactory(bridge);
  }

  getApiFactory(): VscodeApiFactory {
    return this.apiFactory;
  }

  getConfigurationDefaults(): Record<string, unknown> {
    return this.configDefaults;
  }

  async reload(plugins: PluginInfo[]): Promise<void> {
    await this.deactivateAll();
    this.configDefaults = collectConfigDefaults(plugins.filter((p) => p.enabled));
    this.installRequireHook();
    this.api = this.apiFactory.createApi();
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      await this.activateOne(plugin);
    }
  }

  async deactivateAll(): Promise<void> {
    for (const ext of [...this.loaded].reverse()) {
      try {
        await ext.deactivate?.();
      } catch (err) {
        console.error("extension deactivate failed", ext.id, err);
      }
      for (const sub of ext.subscriptions) {
        try {
          sub.dispose();
        } catch {
          /* ignore */
        }
      }
    }
    this.loaded = [];
    this.apiFactory.clearUi();
  }

  fireWorkspaceChange(): void {
    this.apiFactory.fireWorkspaceChange();
  }

  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    return this.apiFactory.executeCommand(command, ...args);
  }

  listRegisteredCommands(): string[] {
    return this.apiFactory.listCommands();
  }

  private installRequireHook(): void {
    if (this.hookInstalled) return;
    this.hookInstalled = true;
    const self = this;
    const ModuleAny = Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const originalLoad = ModuleAny._load;
    ModuleAny._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request === "vscode") {
        if (!self.api) self.api = self.apiFactory.createApi();
        return self.api;
      }
      return originalLoad.apply(this, arguments as unknown as [string, unknown, boolean]);
    };
  }

  private async activateOne(plugin: PluginInfo): Promise<void> {
    const pkgPath = path.join(plugin.path, "package.json");
    if (!fs.existsSync(pkgPath)) return;
    let mainRel = "./extension.js";
    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        main?: string;
        browser?: string;
      };
      mainRel = raw.main || raw.browser || mainRel;
    } catch {
      return;
    }
    if (mainRel.startsWith("./dist/browser") || mainRel.includes("webview")) {
      // skip pure webview / browser builds we cannot run
    }
    const mainPath = path.resolve(plugin.path, mainRel);
    if (!fs.existsSync(mainPath)) {
      console.warn(`[ext] skip ${plugin.id}: missing ${mainPath}`);
      return;
    }

    const subscriptions: { dispose(): void }[] = [];
    const context = {
      subscriptions,
      extensionPath: plugin.path,
      extensionUri: { fsPath: plugin.path, scheme: "file" },
      globalState: memoryMemento(),
      workspaceState: memoryMemento(),
      asAbsolutePath: (rel: string) => path.join(plugin.path, rel),
      extensionMode: 1,
    };

    try {
      const req = createRequire(pkgPath);
      // Bust cache so reinstall/reload picks up new code
      try {
        const resolved = req.resolve(mainPath);
        delete req.cache[resolved];
      } catch {
        /* ignore */
      }
      const mod = req(mainPath) as {
        activate?: (ctx: typeof context) => void | Promise<void>;
        deactivate?: () => void | Promise<void>;
      };
      if (typeof mod.activate !== "function") {
        console.warn(`[ext] skip ${plugin.id}: no activate()`);
        return;
      }
      await mod.activate(context);
      this.loaded.push({
        id: plugin.id,
        path: plugin.path,
        deactivate: mod.deactivate?.bind(mod),
        subscriptions,
      });
      console.log(`[ext] activated ${plugin.id}`);
    } catch (err) {
      console.error(`[ext] activate failed ${plugin.id}`, err);
      for (const sub of subscriptions) {
        try {
          sub.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function collectConfigDefaults(plugins: PluginInfo[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const plugin of plugins) {
    const props = (
      plugin.contributes as
        | {
            configuration?: {
              properties?: Record<string, { default?: unknown }>;
            };
          }
        | undefined
    )?.configuration?.properties;
    if (!props) continue;
    for (const [key, schema] of Object.entries(props)) {
      if (schema && "default" in schema) out[key] = schema.default;
    }
  }
  return out;
}

function memoryMemento() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) return store.get(key) as T;
      return defaultValue;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys() {
      return [...store.keys()];
    },
  };
}

/** Build a bridge wired to Electron main services. */
export function createExtensionBridge(deps: {
  getWorkspace: () => string | null;
  getUserConfig: (key: string) => unknown;
  getConfigDefaults: () => Record<string, unknown>;
  terminalHost: () => TerminalHost | null;
  defaultShell: () => ShellKind;
  send: (channel: string, payload: unknown) => void;
  onBuiltin: (command: string, args: unknown[]) => Promise<unknown>;
}): VscodeHostBridge {
  return {
    getWorkspaceFolder: () => deps.getWorkspace(),
    getConfigurationValue: (key) => deps.getUserConfig(key),
    getConfigurationDefaults: () => deps.getConfigDefaults(),
    createTerminalSession: (kind, cwd, title) => {
      const host = deps.terminalHost();
      if (!host) throw new Error("终端未就绪");
      return host.create(kind || deps.defaultShell(), cwd, title);
    },
    writeTerminal: (id, data) => deps.terminalHost()?.write(id, data),
    killTerminal: (id) => deps.terminalHost()?.kill(id),
    emitStatusBar: (items: StatusBarItemState[]) =>
      deps.send("ext:statusBar", items),
    emitOutput: (channels: OutputChannelState[], activeId: string | null) =>
      deps.send("ext:output", { channels, activeId }),
    emitMessage: (msg: ExtMessage) => deps.send("ext:message", msg),
    emitTerminal: (ev: ExtTerminalEvent) => deps.send("ext:terminal", ev),
    executeBuiltinCommand: (command, ...args) => deps.onBuiltin(command, args),
  };
}
