export type ActivityId =
  | "explorer"
  | "search"
  | "scm"
  | "extensions"
  | "settings"
  | "account"
  | "tasks";

export type PanelView = "problems" | "output" | "debug" | "terminal" | "chat";
export type RightView = "outline" | "info" | "chat";
export type ShellKind = "powershell" | "cmd" | "gitbash";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface StatusBarItemDto {
  id: string;
  alignment: "left" | "right";
  priority: number;
  text: string;
  tooltip: string;
  command?: string;
  visible: boolean;
}

export interface OutputChannelDto {
  id: string;
  name: string;
  content: string;
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
  sidebarWidth: number;
  showPanel: boolean;
  showRightSidebar: boolean;
  rightbarWidth: number;
  panelHeight: number;
  panelView: PanelView;
  rightView: RightView;
  defaultTerminal: ShellKind;
  agentApiKey: string;
  pluginsEnabled: Record<string, boolean>;
  extensionSettings: Record<string, Record<string, unknown>>;
  configuration: Record<string, unknown>;
}

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  publisher?: string;
  enabled: boolean;
  path: string;
  installed: boolean;
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
  kind?: "file" | "diff";
  diffStaged?: boolean;
}

/** agent-core 事件 payload(主进程转发给渲染进程)。 */
export interface AgentEventPayload {
  id: string;
  ts: number;
  type:
    | "turn_start"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "final"
    | "verify_result"
    | "stopped"
    | "error"
    | "session_started"
    | "ready";
  turn?: number;
  ok?: boolean;
  content?: string;
  name?: string;
  arguments?: string;
  result?: string;
  message?: string;
}

/** 一条聊天对话消息(由 agent 事件流累积而成)。 */
export interface ChatMessage {
  /** 渲染进程生成的时间戳,用于排序 */
  ts: number;
  /** 消息类型 */
  kind: "thinking" | "tool_call" | "tool_result" | "verify_result" | "final" | "error";
  /** 工具名(tool_call/tool_result) */
  toolName?: string;
  /** 工具参数(tool_call) */
  toolArgs?: string;
  /** 工具结果(tool_result) */
  toolResult?: string;
  /** 文字内容(thinking/final) */
  text?: string;
  /** 错误信息(error) */
  message?: string;
  /** 所属轮次 */
  turn?: number;
  /** 校验结果(verify_result) */
  ok?: boolean;
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
  watchFile: (filePath: string) => Promise<void>;
  unwatchFile: (filePath: string) => Promise<void>;
  watchWorkspace: (root: string | null) => Promise<void>;
  onFileChanged: (cb: (data: { path: string }) => void) => () => void;
  onFileDeleted: (cb: (data: { path: string }) => void) => () => void;
  onTreeChanged: (cb: (data: { path: string; root: string }) => void) => () => void;
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
  installPluginFolder: () => Promise<PluginInfo | null>;
  installPluginVsix: () => Promise<PluginInfo | null>;
  uninstallPlugin: (id: string) => Promise<PluginInfo[]>;
  executeExtensionCommand: (
    command: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  listExtensionCommands: () => Promise<string[]>;
  onExtStatusBar: (cb: (items: StatusBarItemDto[]) => void) => () => void;
  onExtOutput: (
    cb: (data: {
      channels: OutputChannelDto[];
      activeId: string | null;
    }) => void,
  ) => () => void;
  onExtMessage: (
    cb: (data: { type: "info" | "warn" | "error"; text: string }) => void,
  ) => () => void;
  onExtTerminal: (
    cb: (data: {
      action: "created" | "show" | "disposed";
      id: string;
      kind?: ShellKind;
      title?: string;
    }) => void,
  ) => () => void;
  onExtShowPanel: (cb: (view: string) => void) => () => void;
  onExtFocusEditor: (cb: () => void) => () => void;
  termList: () => Promise<{ id: string; kind: ShellKind; title: string }[]>;
  termCreate: (
    kind?: ShellKind,
  ) => Promise<{ id: string; kind: ShellKind; title: string }>;
  termWrite: (id: string, data: string) => Promise<void>;
  termResize: (id: string, cols: number, rows: number) => Promise<void>;
  termKill: (id: string) => Promise<void>;
  gitStatus: (root: string) => Promise<{
    ok: boolean;
    error?: string;
    branch?: string;
    files: {
      path: string;
      index: string;
      worktree: string;
      staged: boolean;
      unstaged: boolean;
      untracked: boolean;
    }[];
  }>;
  gitStage: (root: string, paths: string[]) => Promise<{ ok: boolean; message: string }>;
  gitUnstage: (root: string, paths: string[]) => Promise<{ ok: boolean; message: string }>;
  gitCommit: (root: string, message: string) => Promise<{ ok: boolean; message: string }>;
  gitDiff: (root: string, path: string, staged: boolean) => Promise<{ ok: boolean; diff?: string; error?: string }>;
  gitShow: (root: string, rev: string, path: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  agentRollback: (id: string) => Promise<{ ok: boolean; message: string }>;
  listSessions: () => Promise<{ id: string; title: string; updatedAt: number }[]>;
  loadSession: (id: string) => Promise<{ id: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] } | null>;
  saveSession: (payload: { id: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] }) => Promise<boolean>;
  deleteSession: (id: string) => Promise<boolean>;
  // Agent (agent-core Python 子进程,交互式长对话)
  agentStart: () => Promise<string>;
  agentSend: (id: string, content: string) => Promise<void>;
  agentClear: (id: string) => Promise<void>;
  agentStop: (id: string) => Promise<void>;
  agentList: () => Promise<{ id: string; cwd: string }[]>;
  onAgentEvent: (
    cb: (data: AgentEventPayload) => void,
  ) => () => void;
  onAgentExit: (cb: (data: { id: string; code: number | null }) => void) => () => void;
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<boolean>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  windowToggleDevTools: () => Promise<void>;
  windowReload: () => Promise<void>;
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void;
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
