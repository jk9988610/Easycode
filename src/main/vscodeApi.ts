import path from "node:path";
import { EventEmitter } from "node:events";
import type { TerminalHost, ShellKind } from "./terminal";

export type StatusBarAlignment = 1 | 2;

export interface StatusBarItemState {
  id: string;
  alignment: "left" | "right";
  priority: number;
  text: string;
  tooltip: string;
  command?: string;
  visible: boolean;
}

export interface OutputChannelState {
  id: string;
  name: string;
  content: string;
}

export interface ExtMessage {
  type: "info" | "warn" | "error";
  text: string;
}

export interface ExtTerminalEvent {
  action: "created" | "show" | "disposed";
  id: string;
  kind?: ShellKind;
  title?: string;
}

export interface VscodeHostBridge {
  getWorkspaceFolder(): string | null;
  getConfigurationValue(key: string): unknown;
  getConfigurationDefaults(): Record<string, unknown>;
  createTerminalSession(
    kind: ShellKind,
    cwd?: string,
    title?: string,
  ): { id: string; kind: ShellKind; title: string };
  writeTerminal(id: string, data: string): void;
  killTerminal(id: string): void;
  emitStatusBar(items: StatusBarItemState[]): void;
  emitOutput(channels: OutputChannelState[], activeId: string | null): void;
  emitMessage(msg: ExtMessage): void;
  emitTerminal(ev: ExtTerminalEvent): void;
  executeBuiltinCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

interface Disposable {
  dispose(): void;
}

type CommandHandler = (...args: unknown[]) => unknown;

let statusSeq = 1;
let outputSeq = 1;

export class VscodeApiFactory {
  private bridge: VscodeHostBridge;
  private commands = new Map<string, CommandHandler>();
  private statusItems = new Map<string, StatusBarItemImpl>();
  private outputChannels = new Map<string, OutputChannelImpl>();
  private workspaceEmitter = new EventEmitter();
  private configEmitter = new EventEmitter();
  private activeOutputId: string | null = null;

  constructor(bridge: VscodeHostBridge) {
    this.bridge = bridge;
  }

  createApi() {
    const self = this;
    const StatusBarAlignment = { Left: 1 as const, Right: 2 as const };

    const Uri = {
      file(fsPath: string) {
        return {
          scheme: "file",
          fsPath,
          path: fsPath.replace(/\\/g, "/"),
          toString: () => `file:///${fsPath.replace(/\\/g, "/")}`,
        };
      },
    };

    return {
      StatusBarAlignment,
      Uri,
      window: {
        createStatusBarItem(
          alignment?: StatusBarAlignment | number,
          priority?: number,
        ) {
          const align =
            alignment === StatusBarAlignment.Right ? "right" : "left";
          const item = new StatusBarItemImpl(
            `sb-${statusSeq++}`,
            align,
            priority ?? 0,
            () => self.flushStatusBar(),
            (command) => void self.executeCommand(command),
          );
          self.statusItems.set(item.id, item);
          return item;
        },
        createOutputChannel(name: string) {
          const ch = new OutputChannelImpl(
            `out-${outputSeq++}`,
            name,
            () => self.flushOutput(),
            (id) => {
              self.activeOutputId = id;
              self.flushOutput();
              void self.bridge.executeBuiltinCommand("easycode.showOutput");
            },
          );
          self.outputChannels.set(ch.id, ch);
          return ch;
        },
        createTerminal(options?: { name?: string; cwd?: string }) {
          const info = self.bridge.createTerminalSession(
            "powershell",
            options?.cwd,
            options?.name || "终端",
          );
          self.bridge.emitTerminal({
            action: "created",
            id: info.id,
            kind: info.kind,
            title: info.title,
          });
          return {
            name: info.title,
            show(_preserveFocus?: boolean) {
              self.bridge.emitTerminal({ action: "show", id: info.id });
              void self.bridge.executeBuiltinCommand("easycode.showTerminal");
            },
            sendText(text: string, addNewLine = true) {
              self.bridge.writeTerminal(
                info.id,
                text + (addNewLine ? "\r\n" : ""),
              );
            },
            dispose() {
              self.bridge.killTerminal(info.id);
              self.bridge.emitTerminal({ action: "disposed", id: info.id });
            },
          };
        },
        showInformationMessage(message: string) {
          self.bridge.emitMessage({ type: "info", text: String(message) });
          return Promise.resolve(undefined);
        },
        showWarningMessage(message: string) {
          self.bridge.emitMessage({ type: "warn", text: String(message) });
          return Promise.resolve(undefined);
        },
        showErrorMessage(message: string) {
          self.bridge.emitMessage({ type: "error", text: String(message) });
          return Promise.resolve(undefined);
        },
      },
      commands: {
        registerCommand(command: string, callback: CommandHandler): Disposable {
          self.commands.set(command, callback);
          return {
            dispose: () => {
              if (self.commands.get(command) === callback) {
                self.commands.delete(command);
              }
            },
          };
        },
        executeCommand(command: string, ...args: unknown[]) {
          return self.executeCommand(command, ...args);
        },
      },
      workspace: {
        get workspaceFolders() {
          const folder = self.bridge.getWorkspaceFolder();
          if (!folder) return undefined;
          return [
            {
              uri: Uri.file(folder),
              name: path.basename(folder),
              index: 0,
            },
          ];
        },
        getConfiguration(section?: string) {
          return {
            get<T>(key: string, defaultValue?: T): T | undefined {
              const full = section ? `${section}.${key}` : key;
              const defaults = self.bridge.getConfigurationDefaults();
              const user = self.bridge.getConfigurationValue(full);
              if (user !== undefined) return user as T;
              if (defaults[full] !== undefined) return defaults[full] as T;
              return defaultValue;
            },
            has(key: string) {
              const full = section ? `${section}.${key}` : key;
              const defaults = self.bridge.getConfigurationDefaults();
              return (
                self.bridge.getConfigurationValue(full) !== undefined ||
                defaults[full] !== undefined
              );
            },
            inspect() {
              return undefined;
            },
            update() {
              return Promise.resolve();
            },
          };
        },
        onDidChangeWorkspaceFolders(listener: () => void): Disposable {
          const fn = () => listener();
          self.workspaceEmitter.on("change", fn);
          return { dispose: () => self.workspaceEmitter.off("change", fn) };
        },
        onDidChangeConfiguration(
          listener: (e: { affectsConfiguration: (section: string) => boolean }) => void,
        ): Disposable {
          const fn = (changed: string[]) =>
            listener({
              affectsConfiguration: (section: string) =>
                changed.some(
                  (k) => k === section || k.startsWith(section + "."),
                ),
            });
          self.configEmitter.on("change", fn);
          return { dispose: () => self.configEmitter.off("change", fn) };
        },
      },
    };
  }

  fireWorkspaceChange(): void {
    this.workspaceEmitter.emit("change");
  }

  fireConfigurationChange(keys: string[]): void {
    this.configEmitter.emit("change", keys);
  }

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.commands.get(command);
    if (handler) return handler(...args);
    return this.bridge.executeBuiltinCommand(command, ...args);
  }

  listCommands(): string[] {
    return [...this.commands.keys()];
  }

  clearUi(): void {
    for (const item of this.statusItems.values()) item.dispose();
    this.statusItems.clear();
    for (const ch of this.outputChannels.values()) ch.dispose();
    this.outputChannels.clear();
    this.activeOutputId = null;
    this.commands.clear();
    this.flushStatusBar();
    this.flushOutput();
  }

  private flushStatusBar(): void {
    const items = [...this.statusItems.values()]
      .filter((i) => i.visible)
      .map((i) => i.toState())
      .sort((a, b) => {
        if (a.alignment !== b.alignment) {
          return a.alignment === "left" ? -1 : 1;
        }
        return b.priority - a.priority;
      });
    this.bridge.emitStatusBar(items);
  }

  private flushOutput(): void {
    const channels = [...this.outputChannels.values()].map((c) => c.toState());
    this.bridge.emitOutput(channels, this.activeOutputId);
  }
}

class StatusBarItemImpl implements Disposable {
  id: string;
  alignment: "left" | "right";
  priority: number;
  visible = false;
  private _text = "";
  private _tooltip: string | undefined;
  private _command: string | undefined;
  private onChange: () => void;
  private onCommand: (command: string) => void;

  constructor(
    id: string,
    alignment: "left" | "right",
    priority: number,
    onChange: () => void,
    onCommand: (command: string) => void,
  ) {
    this.id = id;
    this.alignment = alignment;
    this.priority = priority;
    this.onChange = onChange;
    this.onCommand = onCommand;
  }

  get text(): string {
    return this._text;
  }
  set text(v: string) {
    this._text = v ?? "";
    if (this.visible) this.onChange();
  }

  get tooltip(): string | undefined {
    return this._tooltip;
  }
  set tooltip(v: string | undefined) {
    this._tooltip = v;
    if (this.visible) this.onChange();
  }

  get command(): string | undefined {
    return this._command;
  }
  set command(v: string | undefined) {
    this._command = v;
    if (this.visible) this.onChange();
  }

  show(): void {
    this.visible = true;
    this.onChange();
  }

  hide(): void {
    this.visible = false;
    this.onChange();
  }

  dispose(): void {
    this.visible = false;
    this.onChange();
  }

  toState(): StatusBarItemState {
    return {
      id: this.id,
      alignment: this.alignment,
      priority: this.priority,
      text: this._text,
      tooltip: typeof this._tooltip === "string" ? this._tooltip : "",
      command: this._command,
      visible: this.visible,
    };
  }
}

class OutputChannelImpl implements Disposable {
  id: string;
  name: string;
  content = "";
  private onChange: () => void;
  private onShow: (id: string) => void;

  constructor(
    id: string,
    name: string,
    onChange: () => void,
    onShow: (id: string) => void,
  ) {
    this.id = id;
    this.name = name;
    this.onChange = onChange;
    this.onShow = onShow;
  }

  append(value: string): void {
    this.content += value;
    this.onChange();
  }

  appendLine(value: string): void {
    this.content += value + "\n";
    this.onChange();
  }

  clear(): void {
    this.content = "";
    this.onChange();
  }

  show(_preserveFocus?: boolean): void {
    this.onShow(this.id);
  }

  hide(): void {
    /* no-op */
  }

  dispose(): void {
    this.content = "";
    this.onChange();
  }

  toState(): OutputChannelState {
    return { id: this.id, name: this.name, content: this.content };
  }
}
