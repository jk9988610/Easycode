export type ActivityId = "explorer" | "compare" | "extensions" | "settings";
export type ShellKind = "powershell" | "cmd" | "gitbash";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface AppSettings {
  lastWorkspace: string;
  windowWidth: number;
  windowHeight: number;
  windowX?: number;
  windowY?: number;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  autoSave: boolean;
  autoDetectLanguage: boolean;
  autoDetectEncoding: boolean;
  showSidebar: boolean;
  showPanel: boolean;
  showRightSidebar: boolean;
  panelHeight: number;
  defaultTerminal: ShellKind;
  pythonPath: string;
  compareRoot: string;
  compareDirA: string;
  compareDirB: string;
  ignoreWhitespace: boolean;
  pluginsEnabled: Record<string, boolean>;
  extensionSettings: Record<string, Record<string, unknown>>;
}

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  original: string;
  dirty: boolean;
  language: string;
  encoding: string;
  view?: "code" | "diff";
  diff?: {
    original: string;
    modified: string;
    originalPath?: string;
    modifiedPath?: string;
  };
}

export interface FileChange {
  rel: string;
  kind: string;
  diff_lines: string[];
  lines_a: string[];
  lines_b: string[];
  path_a: string | null;
  path_b: string | null;
}

export interface CompareResult {
  error: string | null;
  only_a: number;
  only_b: number;
  common: number;
  changes: FileChange[];
}

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  path: string;
  installed: boolean;
  contributes?: {
    activity?: string;
    languageServers?: unknown[];
    commands?: { id: string; title: string }[];
  };
}

export interface EasycodeApi {
  getSettings: () => Promise<AppSettings>;
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  openFolder: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  listDir: (dirPath: string) => Promise<DirEntry[]>;
  readFile: (
    filePath: string,
    opts?: { autoDetectEncoding?: boolean; encoding?: string },
  ) => Promise<{ content: string; encoding: string }>;
  writeFile: (
    filePath: string,
    content: string,
    encoding?: string,
  ) => Promise<boolean>;
  exists: (filePath: string) => Promise<boolean>;
  compareRun: (
    dirA: string,
    dirB: string,
    opts?: { ignoreWhitespace?: boolean },
  ) => Promise<CompareResult>;
  lspRequest: (method: string, params: unknown) => Promise<unknown>;
  lspNotify: (method: string, params: unknown) => Promise<void>;
  lspStatus: () => Promise<{
    running: boolean;
    servers?: string[];
    workspace: string | null;
  }>;
  lspRestart: () => Promise<{ running: boolean; servers?: string[] }>;
  listPlugins: () => Promise<PluginInfo[]>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginInfo[]>;
  installPluginFolder: () => Promise<PluginInfo[] | null>;
  uninstallPlugin: (id: string) => Promise<PluginInfo[]>;
  termList: () => Promise<{ id: string; kind: ShellKind; title: string }[]>;
  termCreate: (
    kind?: ShellKind,
  ) => Promise<{ id: string; kind: ShellKind; title: string }>;
  termWrite: (id: string, data: string) => Promise<void>;
  termResize: (id: string, cols: number, rows: number) => Promise<void>;
  termKill: (id: string) => Promise<void>;
  onMenu: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  onLspNotification: (
    cb: (data: { method: string; params: unknown }) => void,
  ) => () => void;
  onLspStatus: (
    cb: (data: {
      running: boolean;
      servers?: string[];
      workspace?: string;
    }) => void,
  ) => () => void;
  onTermData: (cb: (data: { id: string; data: string }) => void) => () => void;
  onTermExit: (
    cb: (data: { id: string; code: number | null }) => void,
  ) => () => void;
}

declare global {
  interface Window {
    easycode: EasycodeApi;
  }
}

export {};
