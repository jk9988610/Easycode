import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

export type PanelView = "problems" | "output" | "debug" | "terminal" | "chat";
export type RightView = "outline" | "info" | "chat";

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
  defaultTerminal: "powershell" | "cmd" | "gitbash";
  /** DeepSeek API key for agent-core. */
  agentApiKey: string;
  /** Reserved for future extension-contributed language servers. */
  pluginsEnabled: Record<string, boolean>;
  extensionSettings: Record<string, Record<string, unknown>>;
  /** VS Code-style configuration keys, e.g. cursorKeilBar.uv4Path */
  configuration: Record<string, unknown>;
}

const DEFAULTS: AppSettings = {
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
  pluginsEnabled: {},
  extensionSettings: {},
  configuration: {},
};

function settingsPath(): string {
  try {
    return path.join(app.getPath("userData"), "settings.json");
  } catch {
    return path.join(os.homedir(), ".easycode", "settings.json");
  }
}

export function loadSettings(): AppSettings {
  const data: AppSettings = {
    ...DEFAULTS,
    pluginsEnabled: { ...DEFAULTS.pluginsEnabled },
    extensionSettings: { ...DEFAULTS.extensionSettings },
    configuration: { ...DEFAULTS.configuration },
  };
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return data;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<AppSettings>;
    Object.assign(data, raw);
    data.pluginsEnabled = { ...(raw.pluginsEnabled || {}) };
    data.extensionSettings = { ...(raw.extensionSettings || {}) };
    data.configuration = { ...(raw.configuration || {}) };
    if (!data.panelView) data.panelView = DEFAULTS.panelView;
    if (!data.rightView) data.rightView = DEFAULTS.rightView;
  } catch {
    /* keep defaults */
  }
  return data;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const next: AppSettings = {
    ...current,
    ...patch,
    pluginsEnabled: {
      ...current.pluginsEnabled,
      ...(patch.pluginsEnabled || {}),
    },
    extensionSettings: {
      ...current.extensionSettings,
      ...(patch.extensionSettings || {}),
    },
    configuration: {
      ...current.configuration,
      ...(patch.configuration || {}),
    },
  };
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("saveSettings failed", err);
  }
  return next;
}
