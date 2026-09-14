import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings, AppSettings } from "./settings";
import { listDirChildren, readTextFile, writeTextFile, fileExists } from "./fsService";
import { LanguageServerSession } from "./languageServer";
import { runCompare } from "./compareBridge";
import { PluginHost } from "./plugins";
import { TerminalHost, type ShellKind } from "./terminal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let pluginHost: PluginHost | null = null;
let terminalHost: TerminalHost | null = null;
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
      autoSave: false,
      autoDetectLanguage: true,
      autoDetectEncoding: true,
      showSidebar: true,
      showPanel: false,
      showRightSidebar: false,
      panelHeight: 220,
      defaultTerminal: "powershell",
      pythonPath: "python",
      compareRoot: "E:\\tools\\compare",
      compareDirA: "",
      compareDirB: "",
      ignoreWhitespace: false,
      pluginsEnabled: {},
      extensionSettings: {},
    };
  }
}

function preloadPath(): string {
  return path.join(__dirname, "preload.cjs");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: settings.windowWidth || 1280,
    height: settings.windowHeight || 800,
    x: settings.windowX,
    y: settings.windowY,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#1a1f24",
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
  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => {
    settings = saveSettings(patch);
    pluginHost?.updateSettings(settings);
    if (patch.extensionSettings || patch.pluginsEnabled) {
      void restartLanguageServers();
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
      writeTextFile(filePath, content, encoding || "utf-8");
      return true;
    },
  );
  ipcMain.handle("fs:exists", (_e, filePath: string) => fileExists(filePath));

  ipcMain.handle("term:list", () => terminalHost?.list() ?? []);
  ipcMain.handle("term:create", (_e, kind?: ShellKind) => {
    const s = loadSettings();
    const shell = kind || s.defaultTerminal || "powershell";
    return terminalHost!.create(shell, s.lastWorkspace || undefined);
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

  ipcMain.handle(
    "compare:run",
    async (
      _e,
      dirA: string,
      dirB: string,
      opts: { ignoreWhitespace?: boolean } = {},
    ) => {
      const s = loadSettings();
      if (s.pluginsEnabled?.compare === false) {
        return { error: "Compare 扩展已禁用", changes: [] };
      }
      return runCompare(dirA, dirB, {
        pythonPath: s.pythonPath,
        compareRoot: s.compareRoot,
        ignoreWhitespace: !!opts.ignoreWhitespace,
      });
    },
  );

  ipcMain.handle("lsp:request", async (_e, method: string, params: unknown) => {
    const session = pickServer(params);
    if (!session?.ready) throw new Error("没有可用的语言服务器（请安装并启用扩展，如 clangd）");
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
  ipcMain.handle("plugins:setEnabled", (_e, id: string, enabled: boolean) => {
    const s = loadSettings();
    const map = { ...(s.pluginsEnabled || {}) };
    map[id] = enabled;
    settings = saveSettings({ pluginsEnabled: map });
    pluginHost?.updateSettings(settings);
    void restartLanguageServers();
    return pluginHost?.list() ?? [];
  });

  ipcMain.handle("plugins:installFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择扩展目录（含 package.json）",
    });
    if (res.canceled || !res.filePaths[0]) return null;
    try {
      const info = pluginHost!.installFromFolder(res.filePaths[0]);
      settings = saveSettings({
        pluginsEnabled: { ...loadSettings().pluginsEnabled, [info.id]: true },
      });
      pluginHost?.updateSettings(settings);
      await restartLanguageServers();
      return pluginHost?.list() ?? [];
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("plugins:uninstall", async (_e, id: string) => {
    pluginHost?.uninstall(id);
    const map = { ...loadSettings().pluginsEnabled };
    delete map[id];
    settings = saveSettings({ pluginsEnabled: map });
    pluginHost?.updateSettings(settings);
    await restartLanguageServers();
    return pluginHost?.list() ?? [];
  });
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
      label: "扩展",
      submenu: [
        {
          label: "从文件夹安装扩展…",
          click: () => mainWindow?.webContents.send("menu:installExtension"),
        },
        {
          label: "重启语言服务器",
          click: () => void restartLanguageServers(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  app.setName("Easycode");
  settings = loadSettings();
  const extCandidates = [
    path.join(process.cwd(), "extensions"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions"),
  ];
  const extRoot =
    extCandidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) || extCandidates[0];
  pluginHost = new PluginHost(extRoot, settings);
  terminalHost = new TerminalHost({
    onData: (id, data) => {
      mainWindow?.webContents.send("term:data", { id, data });
    },
    onExit: (id, code) => {
      mainWindow?.webContents.send("term:exit", { id, code });
    },
  });
  registerIpc();
  buildMenu();
  createWindow();

  if (settings.lastWorkspace) {
    await restartLanguageServers(settings.lastWorkspace);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void stopAllServers();
  terminalHost?.dispose();
  if (process.platform !== "darwin") app.quit();
});
