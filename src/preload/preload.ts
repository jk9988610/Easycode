import { contextBridge, ipcRenderer } from "electron";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type ShellKind = "powershell" | "cmd" | "gitbash";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke("settings:set", patch),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  pickFolder: () => ipcRenderer.invoke("dialog:openFolders"),
  listDir: (dirPath: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke("fs:listDir", dirPath),
  readFile: (
    filePath: string,
    opts?: { autoDetectEncoding?: boolean; encoding?: string },
  ): Promise<{ content: string; encoding: string }> =>
    ipcRenderer.invoke("fs:readFile", filePath, opts || {}),
  writeFile: (
    filePath: string,
    content: string,
    encoding?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke("fs:writeFile", filePath, content, encoding || "utf-8"),
  exists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:exists", filePath),
  watchFile: (filePath: string) => ipcRenderer.invoke("fs:watch", filePath),
  unwatchFile: (filePath: string) => ipcRenderer.invoke("fs:unwatch", filePath),
  watchWorkspace: (root: string | null) =>
    ipcRenderer.invoke("fs:watchWorkspace", root || ""),
  onFileChanged: (cb: (data: { path: string }) => void) => {
    const listener = (_: unknown, data: { path: string }) => cb(data);
    ipcRenderer.on("fs:changed", listener);
    return () => ipcRenderer.removeListener("fs:changed", listener);
  },
  onFileDeleted: (cb: (data: { path: string }) => void) => {
    const listener = (_: unknown, data: { path: string }) => cb(data);
    ipcRenderer.on("fs:deleted", listener);
    return () => ipcRenderer.removeListener("fs:deleted", listener);
  },
  onTreeChanged: (cb: (data: { path: string; root: string }) => void) => {
    const listener = (_: unknown, data: { path: string; root: string }) => cb(data);
    ipcRenderer.on("fs:tree", listener);
    return () => ipcRenderer.removeListener("fs:tree", listener);
  },
  lspRequest: (method: string, params: unknown) =>
    ipcRenderer.invoke("lsp:request", method, params),
  lspNotify: (method: string, params: unknown) =>
    ipcRenderer.invoke("lsp:notify", method, params),
  lspStatus: () => ipcRenderer.invoke("lsp:status"),
  lspRestart: () => ipcRenderer.invoke("lsp:restart"),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  setPluginEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("plugins:setEnabled", id, enabled),
  installPluginFolder: () => ipcRenderer.invoke("plugins:installFolder"),
  installPluginVsix: () => ipcRenderer.invoke("plugins:installVsix"),
  uninstallPlugin: (id: string) => ipcRenderer.invoke("plugins:uninstall", id),
  executeExtensionCommand: (command: string, ...args: unknown[]) =>
    ipcRenderer.invoke("ext:executeCommand", command, ...args),
  listExtensionCommands: () => ipcRenderer.invoke("ext:listCommands"),
  onExtStatusBar: (
    cb: (
      items: {
        id: string;
        alignment: "left" | "right";
        priority: number;
        text: string;
        tooltip: string;
        command?: string;
        visible: boolean;
      }[],
    ) => void,
  ) => {
    const listener = (
      _: unknown,
      items: {
        id: string;
        alignment: "left" | "right";
        priority: number;
        text: string;
        tooltip: string;
        command?: string;
        visible: boolean;
      }[],
    ) => cb(items);
    ipcRenderer.on("ext:statusBar", listener);
    return () => ipcRenderer.removeListener("ext:statusBar", listener);
  },
  onExtOutput: (
    cb: (data: {
      channels: { id: string; name: string; content: string }[];
      activeId: string | null;
    }) => void,
  ) => {
    const listener = (
      _: unknown,
      data: {
        channels: { id: string; name: string; content: string }[];
        activeId: string | null;
      },
    ) => cb(data);
    ipcRenderer.on("ext:output", listener);
    return () => ipcRenderer.removeListener("ext:output", listener);
  },
  onExtMessage: (
    cb: (data: { type: "info" | "warn" | "error"; text: string }) => void,
  ) => {
    const listener = (
      _: unknown,
      data: { type: "info" | "warn" | "error"; text: string },
    ) => cb(data);
    ipcRenderer.on("ext:message", listener);
    return () => ipcRenderer.removeListener("ext:message", listener);
  },
  onExtTerminal: (
    cb: (data: {
      action: "created" | "show" | "disposed";
      id: string;
      kind?: ShellKind;
      title?: string;
    }) => void,
  ) => {
    const listener = (
      _: unknown,
      data: {
        action: "created" | "show" | "disposed";
        id: string;
        kind?: ShellKind;
        title?: string;
      },
    ) => cb(data);
    ipcRenderer.on("ext:terminal", listener);
    return () => ipcRenderer.removeListener("ext:terminal", listener);
  },
  onExtShowPanel: (cb: (view: string) => void) => {
    const listener = (_: unknown, view: string) => cb(view);
    ipcRenderer.on("ext:showPanel", listener);
    return () => ipcRenderer.removeListener("ext:showPanel", listener);
  },
  onExtFocusEditor: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("ext:focusEditor", listener);
    return () => ipcRenderer.removeListener("ext:focusEditor", listener);
  },
  termList: () => ipcRenderer.invoke("term:list"),
  termCreate: (kind?: ShellKind) => ipcRenderer.invoke("term:create", kind),
  termWrite: (id: string, data: string) =>
    ipcRenderer.invoke("term:write", id, data),
  termResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("term:resize", id, cols, rows),
  termKill: (id: string) => ipcRenderer.invoke("term:kill", id),
  gitStatus: (root: string) => ipcRenderer.invoke("git:status", root),
  gitStage: (root: string, paths: string[]) => ipcRenderer.invoke("git:stage", root, paths),
  gitUnstage: (root: string, paths: string[]) => ipcRenderer.invoke("git:unstage", root, paths),
  gitCommit: (root: string, message: string) => ipcRenderer.invoke("git:commit", root, message),
  gitDiff: (root: string, path: string, staged: boolean) => ipcRenderer.invoke("git:diff", root, path, staged),
  gitShow: (root: string, rev: string, path: string) => ipcRenderer.invoke("git:show", root, rev, path),
  // Agent (agent-core Python 子进程,交互式长对话)
  agentStart: (): Promise<string> => ipcRenderer.invoke("agent:start"),
  agentSend: (id: string, content: string): Promise<void> =>
    ipcRenderer.invoke("agent:send", id, content),
  agentClear: (id: string): Promise<void> =>
    ipcRenderer.invoke("agent:clear", id),
  agentStop: (id: string): Promise<void> =>
    ipcRenderer.invoke("agent:stop", id),
  agentRollback: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("agent:rollback", id),
  listSessions: () => ipcRenderer.invoke("session:list"),
  loadSession: (id: string) => ipcRenderer.invoke("session:load", id),
  saveSession: (payload: { id: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] }) =>
    ipcRenderer.invoke("session:save", payload),
  deleteSession: (id: string) => ipcRenderer.invoke("session:delete", id),
  agentList: () => ipcRenderer.invoke("agent:list"),
  onAgentEvent: (
    cb: (data: {
      id: string;
      ts: number;
      type: string;
      turn?: number;
      content?: string;
      name?: string;
      arguments?: string;
      result?: string;
      message?: string;
    }) => void,
  ) => {
    const listener = (
      _: unknown,
      data: {
        id: string;
        ts: number;
        type: string;
        turn?: number;
        content?: string;
        name?: string;
        arguments?: string;
        result?: string;
        message?: string;
      },
    ) => cb(data);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onAgentExit: (cb: (data: { id: string; code: number | null }) => void) => {
    const listener = (_: unknown, data: { id: string; code: number | null }) =>
      cb(data);
    ipcRenderer.on("agent:exit", listener);
    return () => ipcRenderer.removeListener("agent:exit", listener);
  },
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  windowToggleDevTools: () => ipcRenderer.invoke("window:toggleDevTools"),
  windowReload: () => ipcRenderer.invoke("window:reload"),
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },
  onMenu: (channel: string, cb: (...args: unknown[]) => void) => {
    const listener = (_: unknown, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onLspNotification: (cb: (data: { method: string; params: unknown }) => void) => {
    const listener = (_: unknown, data: { method: string; params: unknown }) =>
      cb(data);
    ipcRenderer.on("lsp:notification", listener);
    return () => ipcRenderer.removeListener("lsp:notification", listener);
  },
  onLspStatus: (
    cb: (data: { running: boolean; servers?: string[]; workspace?: string }) => void,
  ) => {
    const listener = (
      _: unknown,
      data: { running: boolean; servers?: string[]; workspace?: string },
    ) => cb(data);
    ipcRenderer.on("lsp:status", listener);
    return () => ipcRenderer.removeListener("lsp:status", listener);
  },
  onTermData: (cb: (data: { id: string; data: string }) => void) => {
    const listener = (_: unknown, data: { id: string; data: string }) => cb(data);
    ipcRenderer.on("term:data", listener);
    return () => ipcRenderer.removeListener("term:data", listener);
  },
  onTermExit: (cb: (data: { id: string; code: number | null }) => void) => {
    const listener = (_: unknown, data: { id: string; code: number | null }) =>
      cb(data);
    ipcRenderer.on("term:exit", listener);
    return () => ipcRenderer.removeListener("term:exit", listener);
  },
};

contextBridge.exposeInMainWorld("easycode", api);

export type EasycodeApi = typeof api;
