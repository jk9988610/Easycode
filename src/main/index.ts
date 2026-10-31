import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { spawn } from "node:child_process";
import { gitStatus, gitStage, gitUnstage, gitCommit, gitDiff, gitShow } from "./git";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings, AppSettings } from "./settings";
import { listDirChildren, readTextFile, writeTextFile, fileExists } from "./fsService";
import { LanguageServerSession } from "./languageServer";
import { PluginHost } from "./plugins";
import { TerminalHost, type ShellKind } from "./terminal";
import { FileWatcher } from "./fileWatcher";
import { ExtensionHost, createExtensionBridge } from "./extensionHost";
import { AgentHost, type AgentEvent } from "./agentHost";
import { listSessions, loadSession, saveSession, deleteSession } from "./sessionStore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let pluginHost: PluginHost | null = null;
let extensionHost: ExtensionHost | null = null;
let terminalHost: TerminalHost | null = null;
let agentHost: AgentHost | null = null;
let fileWatcher: FileWatcher | null = null;
let settings: AppSettings = loadSettingsSafe();
/** Active language servers keyed by server id (from extension contributes). */
const servers = new Map<string, LanguageServerSession>();
const crashCounts = new Map<string, number>();

function loadSettingsSafe(): AppSettings {
  try {
    return loadSettings();
  } catch {
    return {
      lastWorkspace: "",
      windowWidth: 1280,
      windowHeight: 800,
      fontSize: 14,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      wordWrap: false,
      autoSave: true,
      autoDetectLanguage: true,
      autoDetectEncoding: true,
      showSidebar: true,
      sidebarWidth: 260,
      showPanel: false,
      showRightSidebar: false,
      rightbarWidth: 240,
      panelHeight: 220,
      panelView: "terminal",
      rightView: "info",
      defaultTerminal: "powershell",
      agentApiKey: "",
      qiniuApiKey: "",
      agentModel: "qiniu/conatus-free",
      pluginsEnabled: {},
      extensionSettings: {},
      configuration: {},
    };
  }
}

function preloadPath(): string {
  return path.join(__dirname, "preload.cjs");
}

/**
 * 轮询 Easycode 自身的 .easycode/need_restart 标记。
 * Agent 改完 Easycode 自己的代码、typecheck 通过后会写这个标记，
 * 主进程发现后 app.relaunch() 重启。
 */
function startRestartPoll(): void {
  const easycodeDir = path.join(app.getAppPath(), ".easycode");
  const flagPath = path.join(easycodeDir, "need_restart");
  const cpPath = path.join(easycodeDir, "checkpoint.json");
  let warned = false;
  setInterval(() => {
    try {
      if (!fs.existsSync(flagPath)) return;
      const reason = fs.readFileSync(flagPath, "utf-8").trim() || "agent";
      fs.unlinkSync(flagPath);
      console.log(`[restart] detected need_restart (reason=${reason}), relaunching...`);
      try {
        fs.mkdirSync(easycodeDir, { recursive: true });
        fs.writeFileSync(cpPath, JSON.stringify({
          reason,
          timestamp: new Date().toISOString(),
          pid: process.pid,
        }), "utf-8");
      } catch {}
      // supervised 模式:spawn launch.ps1(它有 watchdog + 回滚能力)
      // 非 supervised 模式(如 npm run dev):直接 app.relaunch()
      if (process.env.EASYCODE_SUPERVISED === "1") {
        const launcher = path.join(app.getAppPath(), "launch.ps1");
        if (fs.existsSync(launcher)) {
          console.log(`[restart] spawning launcher: ${launcher}`);
          spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", launcher], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
          app.exit(0);
          return;
        }
      }
      console.log(`[restart] unsupervised, using app.relaunch()`);
      app.relaunch();
      app.exit(0);
    } catch (e) {
      if (!warned) {
        console.error("[restart] poll error:", e);
        warned = true;
      }
    }
  }, 1000);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: settings.windowWidth || 1280,
    height: settings.windowHeight || 800,
    x: settings.windowX,
    y: settings.windowY,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    resizable: true,
    thickFrame: true,
    backgroundColor: "#1a1f24",
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "Easycode",
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  const __t = () => Date.now() - ((globalThis as any).__easycodeT0 ?? Date.now());
  mainWindow.webContents.on("did-start-loading", () => {
    console.log(`[startup] did-start-loading: ${__t()}ms`);
  });
  mainWindow.webContents.on("dom-ready", () => {
    console.log(`[startup] dom-ready: ${__t()}ms`);
  });
  (mainWindow.webContents as any).on("console-message", (...args: any[]) => {
    const d = typeof args[1] === "object" && args[1] !== null ? args[1] : { message: args[2] };
    const msg = d?.message ?? "";
    if (msg) console.log(`[renderer] ${msg}`);
  });

  const __t0 = (globalThis as any).__easycodeT0 ?? Date.now();
  mainWindow.once("ready-to-show", () => {
    const elapsed = Date.now() - __t0;
    console.log(`[startup] ready-to-show: ${elapsed}ms`);
    mainWindow?.show();
    setImmediate(() => (globalThis as any).__initHosts?.());
    // 窗口可见后再启动 LSP:首屏不付 LSP 启动成本,用户输入前也感知不到差异
    const ws = settings.lastWorkspace;
    if (ws) {
      setTimeout(() => {
        void restartLanguageServers(ws).catch((e) =>
          console.error("[lsp] start failed", e),
        );
      }, 800);
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log(`[startup] did-finish-load: ${Date.now() - ((globalThis as any).__easycodeT0 ?? Date.now())}ms`);
    void reloadExtensions();
  });

  const sendMaximized = () => {
    mainWindow?.webContents.send("window:maximized", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("did-fail-load", code, desc, url);
    if (process.env.VITE_DEV_SERVER_URL && mainWindow) {
      setTimeout(() => {
        void mainWindow?.loadURL(process.env.VITE_DEV_SERVER_URL!);
      }, 800);
    }
  });

  mainWindow.on("close", () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    saveSettings({
      windowWidth: b.width,
      windowHeight: b.height,
      windowX: b.x,
      windowY: b.y,
    });
    settings = loadSettings();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function lspStatusPayload() {
  const running = [...servers.values()].filter((s) => s.ready).map((s) => s.spec.id);
  return {
    running: running.length > 0,
    servers: running,
    workspace: settings.lastWorkspace || null,
  };
}

function registerIpc(): void {
  ipcMain.handle("window:minimize", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", () => {
    mainWindow?.close();
  });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("window:toggleDevTools", () => {
    mainWindow?.webContents.toggleDevTools();
  });
  ipcMain.handle("window:reload", () => {
    mainWindow?.webContents.reload();
  });

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => {
    const prevConfig = { ...settings.configuration };
    settings = saveSettings(patch);
    pluginHost?.updateSettings(settings);
    if (patch.pluginsEnabled) {
      void restartLanguageServers();
      void reloadExtensions();
    }
    if (patch.configuration) {
      const keys = Object.keys(patch.configuration);
      extensionHost?.getApiFactory().fireConfigurationChange(keys);
      // also fire keys that changed vs previous
      for (const k of Object.keys(prevConfig)) {
        if (!(k in (patch.configuration || {}))) keys.push(k);
      }
    }
    return settings;
  });

  ipcMain.handle("dialog:openFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const folder = res.filePaths[0];
    saveSettings({ lastWorkspace: folder });
    settings = loadSettings();
    await restartLanguageServers(folder);
    extensionHost?.fireWorkspaceChange();
    return folder;
  });

  ipcMain.handle("dialog:openFolders", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("fs:listDir", (_e, dirPath: string) => listDirChildren(dirPath));
  ipcMain.handle(
    "fs:readFile",
    (
      _e,
      filePath: string,
      opts?: { autoDetectEncoding?: boolean; encoding?: string },
    ) => {
      const s = loadSettings();
      return readTextFile(filePath, {
        autoDetectEncoding: opts?.autoDetectEncoding ?? s.autoDetectEncoding,
        encoding: opts?.encoding,
      });
    },
  );
  ipcMain.handle(
    "fs:writeFile",
    (_e, filePath: string, content: string, encoding?: string) => {
      fileWatcher?.ignore(filePath);
      writeTextFile(filePath, content, encoding || "utf-8");
      return true;
    },
  );
  ipcMain.handle("fs:exists", (_e, filePath: string) => fileExists(filePath));
  ipcMain.handle("fs:watch", (_e, filePath: string) => {
    fileWatcher?.watchFile(filePath);
  });
  ipcMain.handle("fs:unwatch", (_e, filePath: string) => {
    fileWatcher?.unwatchFile(filePath);
  });
  ipcMain.handle("fs:watchWorkspace", (_e, root: string) => {
    if (root) fileWatcher?.watchWorkspace(root);
    else fileWatcher?.unwatchWorkspace();
  });

  ipcMain.handle("git:status", (_e, root: string) => gitStatus(root));
ipcMain.handle("git:stage", (_e, root: string, paths: string[]) => gitStage(root, paths));
ipcMain.handle("git:unstage", (_e, root: string, paths: string[]) => gitUnstage(root, paths));
ipcMain.handle("git:commit", (_e, root: string, message: string) => gitCommit(root, message));
ipcMain.handle("git:diff", (_e, root: string, path: string, staged: boolean) => gitDiff(root, path, staged));
  ipcMain.handle("git:show", (_e, root: string, rev: string, path: string) => gitShow(root, rev, path));

ipcMain.handle("term:list", () => terminalHost?.list() ?? []);
  ipcMain.handle("term:create", (_e, kind?: ShellKind, opts?: { cwd?: string; title?: string }) => {
    const s = loadSettings();
    const shell = kind || s.defaultTerminal || "powershell";
    return terminalHost!.create(
      shell,
      opts?.cwd || s.lastWorkspace || undefined,
      opts?.title,
    );
  });
  ipcMain.handle("term:write", (_e, id: string, data: string) => {
    terminalHost?.write(id, data);
  });
  ipcMain.handle("term:resize", (_e, id: string, cols: number, rows: number) => {
    terminalHost?.resize(id, cols, rows);
  });
  ipcMain.handle("term:kill", (_e, id: string) => {
    terminalHost?.kill(id);
  });

  // --- Agent (agent-core Python 子进程,交互式长对话) ---
  ipcMain.handle("agent:start", () => {
    if (!agentHost) throw new Error("agent host 未初始化");
    // 优先七牛 Key(设置页填 > 环境变量),其次兼容旧的 DeepSeek Key
    const apiKey =
      settings.qiniuApiKey ||
      process.env.QINIU_API_KEY ||
      settings.agentApiKey ||
      process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("未配置 API Key。请在设置 → 聊天 中填写七牛 API Key");
    }
    const model = settings.agentModel || process.env.QINIU_MODEL || undefined;
    const cwd = settings.lastWorkspace;
    if (!cwd || !fs.existsSync(cwd)) throw new Error("未打开工作区,无法启动 agent");
    return agentHost.startSession({ cwd, apiKey, model });
  });
  ipcMain.handle("agent:send", (_e, id: string, content: string) => {
    agentHost?.send(id, content);
  });
  ipcMain.handle("agent:clear", (_e, id: string) => {
    agentHost?.clear(id);
  });
  ipcMain.handle("agent:stop", (_e, id: string) => {
    agentHost?.stop(id);
  });
    ipcMain.handle("agent:rollback", async (_e, id: string) => {
    if (!agentHost) return { ok: false, message: "no agent host" };
    return await agentHost.rollback(id);
  });
ipcMain.handle("agent:list", () => agentHost?.list() ?? []);
ipcMain.handle("session:list", () => listSessions());
ipcMain.handle("session:load", (_e, id: string) => loadSession(id));
ipcMain.handle("session:save", (_e, payload: { id: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] }) => saveSession(payload));
ipcMain.handle("session:delete", (_e, id: string) => deleteSession(id));

  ipcMain.handle("lsp:request", async (_e, method: string, params: unknown) => {
    const session = pickServer(params);
    if (!session?.ready) throw new Error("没有可用的语言服务器");
    return session.request(method, params);
  });

  ipcMain.handle("lsp:notify", async (_e, method: string, params: unknown) => {
    const session = pickServer(params);
    if (!session?.ready) return;
    session.notify(method, params);
  });

  ipcMain.handle("lsp:status", () => lspStatusPayload());
  ipcMain.handle("lsp:restart", async () => {
    await restartLanguageServers();
    return lspStatusPayload();
  });

  ipcMain.handle("plugins:list", () => pluginHost?.list() ?? []);
  ipcMain.handle("plugins:setEnabled", async (_e, id: string, enabled: boolean) => {
    settings = saveSettings({ pluginsEnabled: { [id]: enabled } });
    pluginHost?.updateSettings(settings);
    await restartLanguageServers();
    await reloadExtensions();
    return pluginHost?.list() ?? [];
  });
  ipcMain.handle("plugins:installFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "选择扩展文件夹",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const info = pluginHost!.installFromFolder(res.filePaths[0]);
    await restartLanguageServers();
    await reloadExtensions();
    return info;
  });
  ipcMain.handle("plugins:installVsix", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 VSIX 文件",
      properties: ["openFile"],
      filters: [{ name: "VSIX", extensions: ["vsix"] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const info = pluginHost!.installFromVsix(res.filePaths[0]);
    await restartLanguageServers();
    await reloadExtensions();
    return info;
  });
  ipcMain.handle("plugins:uninstall", async (_e, id: string) => {
    pluginHost?.uninstall(id);
    await restartLanguageServers();
    await reloadExtensions();
    return pluginHost?.list() ?? [];
  });
  ipcMain.handle("ext:executeCommand", async (_e, command: string, ...args: unknown[]) => {
    return extensionHost?.executeCommand(command, ...args);
  });
  ipcMain.handle("ext:listCommands", () => extensionHost?.listRegisteredCommands() ?? []);
}

/** Prefer server matching textDocument language if we can infer; else first ready. */
function pickServer(params: unknown): LanguageServerSession | null {
  const ready = [...servers.values()].filter((s) => s.ready);
  if (!ready.length) return null;
  const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri || "";
  const lower = uri.toLowerCase();
  const byLang = ready.find((s) => {
    const langs = s.spec.languages || [];
    if (!langs.length) return false;
    if (langs.includes("c") && (lower.endsWith(".c") || lower.endsWith(".h"))) return true;
    if (
      langs.includes("cpp") &&
      (lower.endsWith(".cpp") ||
        lower.endsWith(".cc") ||
        lower.endsWith(".cxx") ||
        lower.endsWith(".hpp"))
    )
      return true;
    return langs.some((l) => lower.endsWith("." + l));
  });
  return byLang || ready[0];
}

async function stopAllServers(): Promise<void> {
  const list = [...servers.values()];
  servers.clear();
  await Promise.all(list.map((s) => s.stop().catch(() => undefined)));
}

async function reloadExtensions(): Promise<void> {
  if (!extensionHost || !pluginHost) return;
  settings = loadSettings();
  pluginHost.updateSettings(settings);
  await extensionHost.reload(pluginHost.list());
}

async function restartLanguageServers(workspace?: string): Promise<void> {
  const s = loadSettings();
  settings = s;
  pluginHost?.updateSettings(s);
  const root = workspace || s.lastWorkspace || null;
  await stopAllServers();
  if (!root || !pluginHost) {
    mainWindow?.webContents.send("lsp:status", lspStatusPayload());
    return;
  }

  const specs = pluginHost.resolveLanguageServers();
  for (const spec of specs) {
    const session = new LanguageServerSession({
      spec,
      workspaceRoot: root,
      onNotification: (method, params) => {
        mainWindow?.webContents.send("lsp:notification", { method, params });
      },
      onExit: () => {
        servers.delete(spec.id);
        mainWindow?.webContents.send("lsp:status", lspStatusPayload());
        const key = `${root}:${spec.id}`;
        const count = (crashCounts.get(key) || 0) + 1;
        crashCounts.set(key, count);
        if (count <= 3) {
          setTimeout(() => void restartLanguageServers(root), 1500);
        }
      },
    });
    try {
      await session.start();
      servers.set(spec.id, session);
      crashCounts.set(`${root}:${spec.id}`, 0);
    } catch (err) {
      console.error(`language server ${spec.id} failed`, err);
      mainWindow?.webContents.send("lsp:notification", {
        method: "easycode/serverStartFailed",
        params: {
          serverId: spec.id,
          command: spec.command,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  mainWindow?.webContents.send("lsp:status", lspStatusPayload());
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开文件夹",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu:openFolder"),
        },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu:save"),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "终端",
      submenu: [
        {
          label: "切换底栏面板",
          accelerator: "CmdOrCtrl+J",
          click: () => mainWindow?.webContents.send("menu:togglePanel"),
        },
        {
          label: "新建 PowerShell",
          click: () => mainWindow?.webContents.send("menu:newTerminal", "powershell"),
        },
        {
          label: "新建 CMD",
          click: () => mainWindow?.webContents.send("menu:newTerminal", "cmd"),
        },
        {
          label: "新建 Git Bash",
          click: () => mainWindow?.webContents.send("menu:newTerminal", "gitbash"),
        },
      ],
    },
    {
      label: "查看",
      submenu: [
        {
          label: "命令面板",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => mainWindow?.webContents.send("menu:commandPalette"),
        },
        {
          label: "切换左侧栏",
          accelerator: "CmdOrCtrl+B",
          click: () => mainWindow?.webContents.send("menu:toggleSidebar"),
        },
        {
          label: "切换右侧栏",
          accelerator: "CmdOrCtrl+Alt+B",
          click: () => mainWindow?.webContents.send("menu:toggleRightSidebar"),
        },
        { role: "toggleDevTools", label: "开发者工具" },
        { role: "reload", label: "重新加载" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 Easycode",
          click: () => mainWindow?.webContents.send("menu:about"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

(globalThis as any).__easycodeT0 = Date.now();
app.whenReady().then(async () => {
  console.log(`[startup] whenReady: ${Date.now() - (globalThis as any).__easycodeT0}ms`);
  app.setName("Easycode");
  // 快速路径(VS Code 式):先注册 IPC 并创建窗口,让渲染进程尽早开始加载首屏。
  // 各 Host 与 LSP 的初始化不再阻塞窗口创建。
  registerIpc();
  buildMenu();
  createWindow();
  console.log(`[startup] window created: ${Date.now() - (globalThis as any).__easycodeT0}ms`);
  settings = loadSettings();

  // Host 初始化推迟到首屏可见后(setImmediate),避免阻塞窗口
  (globalThis as any).__initHosts = () => {
    const extRoot = path.join(app.getPath("userData"), "extensions");
    fs.mkdirSync(extRoot, { recursive: true });
    pluginHost = new PluginHost(extRoot, settings);
    fileWatcher = new FileWatcher((event) => {
      if (!mainWindow) return;
      if (event.type === "change") {
        mainWindow.webContents.send("fs:changed", { path: event.path });
      } else if (event.type === "unlink") {
        mainWindow.webContents.send("fs:deleted", { path: event.path });
      } else if (event.type === "tree") {
        mainWindow.webContents.send("fs:tree", {
          path: event.path,
          root: event.root,
        });
      }
    });
    terminalHost = new TerminalHost({
      onData: (id, data) => {
        mainWindow?.webContents.send("term:data", { id, data });
      },
      onExit: (id, code) => {
        mainWindow?.webContents.send("term:exit", { id, code });
      },
    });
    agentHost = new AgentHost({
      onEvent: (id, event: AgentEvent) => {
        mainWindow?.webContents.send("agent:event", { id, ...event });
      },
      onExit: (id, code) => {
        mainWindow?.webContents.send("agent:exit", { id, code });
      },
    });
    extensionHost = new ExtensionHost(
      createExtensionBridge({
        getWorkspace: () => settings.lastWorkspace || null,
        getUserConfig: (key) => settings.configuration?.[key],
        getConfigDefaults: () => extensionHost?.getConfigurationDefaults() || {},
        terminalHost: () => terminalHost,
        defaultShell: () => settings.defaultTerminal || "powershell",
        send: (channel, payload) => {
          mainWindow?.webContents.send(channel, payload);
        },
        onBuiltin: async (command, args) => {
          if (command === "easycode.showOutput") {
            mainWindow?.webContents.send("ext:showPanel", "output");
            return;
          }
          if (command === "easycode.showTerminal") {
            mainWindow?.webContents.send("ext:showPanel", "terminal");
            return;
          }
          if (command === "workbench.action.focusActiveEditorGroup") {
            mainWindow?.webContents.send("ext:focusEditor");
            return;
          }
          if (command === "clangd.restart" || command === "easycode.lspRestart") {
            await restartLanguageServers();
            return lspStatusPayload();
          }
          console.warn("[ext] unknown command", command, args);
        },
      }),
    );

    // Host 就绪后主动加载一次扩展(did-finish-load 可能早于 Host 就绪而空跑)
    void reloadExtensions();
    console.log(`[startup] hosts ready: ${Date.now() - (globalThis as any).__easycodeT0}ms`);
  };

  // LSP 启动已移到 createWindow 的 ready-to-show 回调(窗口可见后 800ms),
  // 这里不再同步/异步启动,彻底移出首屏路径。

  // 启动 need_restart 轮询(Agent 改 Easycode 自身代码后触发重启)
  startRestartPoll();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void extensionHost?.deactivateAll();
  void stopAllServers();
  terminalHost?.dispose();
  agentHost?.dispose();
  fileWatcher?.dispose();
  if (process.platform !== "darwin") app.quit();
});