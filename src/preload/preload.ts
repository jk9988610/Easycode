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
  compareRun: (
    dirA: string,
    dirB: string,
    opts?: { ignoreWhitespace?: boolean },
  ) => ipcRenderer.invoke("compare:run", dirA, dirB, opts || {}),
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
  uninstallPlugin: (id: string) => ipcRenderer.invoke("plugins:uninstall", id),
  termList: () => ipcRenderer.invoke("term:list"),
  termCreate: (kind?: ShellKind) => ipcRenderer.invoke("term:create", kind),
  termWrite: (id: string, data: string) =>
    ipcRenderer.invoke("term:write", id, data),
  termResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("term:resize", id, cols, rows),
  termKill: (id: string) => ipcRenderer.invoke("term:kill", id),
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
