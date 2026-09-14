import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

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
  defaultTerminal: "powershell" | "cmd" | "gitbash";
  pythonPath: string;
  compareRoot: string;
  compareDirA: string;
  compareDirB: string;
  ignoreWhitespace: boolean;
  pluginsEnabled: Record<string, boolean>;
  extensionSettings: Record<string, Record<string, unknown>>;
}

const DEFAULTS: AppSettings = {
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
  };
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return data;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<AppSettings> & {
      clangdPath?: string;
      clangdArgs?: string[];
    };
    Object.assign(data, raw);
    data.pluginsEnabled = { ...(raw.pluginsEnabled || {}) };
    data.extensionSettings = { ...(raw.extensionSettings || {}) };
    if (raw.clangdPath || raw.clangdArgs) {
      data.extensionSettings.clangd = {
        ...(data.extensionSettings.clangd || {}),
        ...(raw.clangdPath ? { command: raw.clangdPath } : {}),
        ...(raw.clangdArgs ? { args: raw.clangdArgs } : {}),
      };
    }
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
