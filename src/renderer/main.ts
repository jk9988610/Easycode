import "./styles.css";
import "./monaco.css";
import {
  monaco,
  languageFromPath,
  pathToUri,
} from "./monacoSetup";
import { LspBridge } from "./lspBridge";
import { TerminalPanel } from "./terminalPanel";
import type {
  ActivityId,
  AppSettings,
  CompareResult,
  EditorTab,
  FileChange,
  PluginInfo,
  ShellKind,
} from "./types";

const KIND_LABEL: Record<string, string> = {
  deleted: "删除",
  added: "新增",
  modified: "修改",
  binary: "二进制",
};

class App {
  private root: HTMLElement;
  private settings!: AppSettings;
  private activity: ActivityId = "explorer";
  private workspace = "";
  private tabs: EditorTab[] = [];
  private activeTabId: string | null = null;
  private expanded = new Set<string>();
  private treeCache = new Map<string, Awaited<ReturnType<typeof window.easycode.listDir>>>();
  private compareResult: CompareResult | null = null;
  private compareBusy = false;
  private activeChangeRel: string | null = null;
  private plugins: PluginInfo[] = [];
  private lspRunning = false;
  private lspServers: string[] = [];
  private cursorLabel = "Ln 1, Col 1";
  private toastTimer: number | null = null;
  private commandOpen = false;
  private commandFilter = "";
  private commandIndex = 0;

  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  private editorEl: HTMLElement | null = null;
  private lsp: LspBridge;
  private changeTimer: number | null = null;
  private terminalPanel: TerminalPanel | null = null;
  private autoSaveTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.lsp = new LspBridge(
      (m, p) => window.easycode.lspRequest(m, p),
      (m, p) => window.easycode.lspNotify(m, p),
    );
  }

  async start(): Promise<void> {
    this.settings = await window.easycode.getSettings();
    this.workspace = this.settings.lastWorkspace || "";
    this.plugins = await window.easycode.listPlugins();
    const st = await window.easycode.lspStatus();
    this.applyLspStatus(st);
    this.lsp.registerProviders();

    window.easycode.onMenu("menu:openFolder", () => void this.openFolder());
    window.easycode.onMenu("menu:save", () => void this.saveActive());
    window.easycode.onMenu("menu:commandPalette", () => this.toggleCommandPalette(true));
    window.easycode.onMenu("menu:installExtension", () => void this.installExtension());
    window.easycode.onMenu("menu:togglePanel", () => void this.togglePanel());
    window.easycode.onMenu("menu:toggleSidebar", () => void this.toggleSidebar());
    window.easycode.onMenu("menu:toggleRightSidebar", () => void this.toggleRightSidebar());
    window.easycode.onMenu("menu:newTerminal", (...args) => {
      const kind = (args[0] as ShellKind | undefined) || this.settings.defaultTerminal;
      void this.openTerminal(kind);
    });
    window.easycode.onLspNotification((data) => {
      if (data.method === "easycode/missingCompileCommands") {
        this.showToast(
          "未找到 compile_commands.json。clangd 提示可能不完整（Keil 工程请自行生成）。",
          false,
        );
        return;
      }
      if (data.method === "easycode/missingWorkspaceFile") {
        const p = data.params as { file?: string; serverId?: string };
        const file = p.file || "工作区文件";
        const server = p.serverId ? `（${p.serverId}）` : "";
        this.showToast(`未找到 ${file}${server}，语言服务提示可能不完整。`, false);
        return;
      }
      if (data.method === "easycode/serverStartFailed") {
        const p = data.params as { serverId?: string; command?: string; message?: string };
        const name = p.serverId || p.command || "语言服务器";
        this.showToast(`${name} 启动失败：${p.message || "未知错误"}`, true);
        return;
      }
      this.lsp.handleNotification(data.method, data.params);
    });
    window.easycode.onLspStatus((data) => {
      this.applyLspStatus(data);
      this.renderStatus();
    });

    window.addEventListener("keydown", (e) => this.onGlobalKey(e));
    window.addEventListener("resize", () => this.terminalPanel?.layout());
    window.addEventListener("beforeunload", (e) => {
      if (this.tabs.some((t) => t.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selection) => {
        let filePath = resource.fsPath;
        if (!filePath && resource.scheme === "file") {
          filePath = decodeURIComponent(resource.path.replace(/^\//, ""));
          if (/^[a-zA-Z]%3A/i.test(filePath) || /^[a-zA-Z]:/.test(filePath) === false) {
            const m = /^\/?([a-zA-Z]):\//.exec(resource.path);
            if (m) {
              filePath = m[1] + ":" + resource.path.slice(m[0].length - 1).replace(/\//g, "\\");
            }
          }
        }
        if (!filePath) return false;
        await this.openFile(filePath);
        const ed = this.editor;
        if (ed && selection) {
          ed.setSelection(selection);
          ed.revealPositionInCenter({
            lineNumber: selection.startLineNumber,
            column: selection.startColumn,
          });
        }
        return true;
      },
    });

    this.render();
    if (this.workspace) {
      this.expanded.add(this.workspace);
      void this.ensureTree(this.workspace);
    }
  }

  private applyLspStatus(st: {
    running: boolean;
    servers?: string[];
  }): void {
    this.lspRunning = st.running;
    this.lspServers = st.servers || [];
    this.lsp.setRunning(st.running);
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void this.saveActive();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      this.toggleCommandPalette(true);
    }
    if (e.ctrlKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      void this.togglePanel();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      void this.toggleSidebar();
    }
    if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
      e.preventDefault();
      void this.openTerminal(this.settings.defaultTerminal);
    }
    if (e.key === "Escape" && this.commandOpen) {
      this.toggleCommandPalette(false);
    }
  }

  private showToast(message: string, isError = false): void {
    const old = document.querySelector(".toast");
    old?.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = message;
    document.body.appendChild(el);
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.remove(), 5000);
  }

  private applyLayoutClasses(): void {
    const shell = this.root.querySelector(".shell") as HTMLElement | null;
    if (!shell) return;
    shell.classList.toggle("no-sidebar", !this.settings.showSidebar);
    shell.classList.toggle("no-panel", !this.settings.showPanel);
    shell.classList.toggle("no-right", !this.settings.showRightSidebar);
    const panelH = `${this.settings.panelHeight}px`;
    shell.style.setProperty("--panel-h", panelH);
    const panel = this.root.querySelector(".bottom-panel") as HTMLElement | null;
    if (panel) panel.style.setProperty("--panel-h", panelH);
  }

  private async toggleSidebar(): Promise<void> {
    this.settings = await window.easycode.setSettings({
      showSidebar: !this.settings.showSidebar,
    });
    this.applyLayoutClasses();
    this.renderTitlebar();
  }

  private async togglePanel(): Promise<void> {
    const next = !this.settings.showPanel;
    this.settings = await window.easycode.setSettings({ showPanel: next });
    this.applyLayoutClasses();
    this.renderTitlebar();
    if (next) {
      this.ensureTerminalPanel();
      if (this.terminalPanel && !this.terminalPanel.hasTabs()) {
        await this.terminalPanel.open(this.settings.defaultTerminal);
      }
      this.renderPanelTabs();
      this.terminalPanel?.layout();
    }
  }

  private async toggleRightSidebar(): Promise<void> {
    this.settings = await window.easycode.setSettings({
      showRightSidebar: !this.settings.showRightSidebar,
    });
    this.applyLayoutClasses();
    this.renderTitlebar();
  }

  private ensureTerminalPanel(): void {
    const host = this.root.querySelector("#term-host") as HTMLElement | null;
    if (!host) return;
    if (!this.terminalPanel) {
      this.terminalPanel = new TerminalPanel(host);
    }
  }

  private async openTerminal(kind: ShellKind): Promise<void> {
    if (!this.settings.showPanel) {
      this.settings = await window.easycode.setSettings({ showPanel: true });
      this.applyLayoutClasses();
      this.renderTitlebar();
    }
    this.ensureTerminalPanel();
    if (!this.terminalPanel) return;
    await this.terminalPanel.open(kind);
    this.renderPanelTabs();
    this.terminalPanel.layout();
  }

  private async openFolder(): Promise<void> {
    const folder = await window.easycode.openFolder();
    if (!folder) return;
    this.workspace = folder;
    this.settings = await window.easycode.getSettings();
    this.treeCache.clear();
    this.expanded = new Set([folder]);
    this.activity = "explorer";
    this.render();
    const st = await window.easycode.lspStatus();
    this.applyLspStatus(st);
    this.renderStatus();
  }

  private async installExtension(): Promise<void> {
    const list = await window.easycode.installPluginFolder();
    if (!list) return;
    this.plugins = list;
    this.showToast("扩展已安装");
    if (this.activity === "extensions") this.renderSidebarBody();
    const st = await window.easycode.lspRestart();
    this.applyLspStatus(st);
    this.renderStatus();
  }

  private async ensureTree(dir: string) {
    if (!this.treeCache.has(dir)) {
      const kids = await window.easycode.listDir(dir);
      this.treeCache.set(dir, kids);
      if (this.activity === "explorer") this.renderSidebarBody();
    }
  }

  private activeTab(): EditorTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  private clangdCommand(): string {
    const clangd = this.settings.extensionSettings?.clangd || {};
    const cmd = clangd.command;
    return typeof cmd === "string" && cmd.trim() ? cmd.trim() : "clangd";
  }

  private async openFile(filePath: string): Promise<void> {
    const existing = this.tabs.find((t) => t.path === filePath && t.view !== "diff");
    if (existing) {
      this.activeTabId = existing.id;
      this.render();
      return;
    }
    const { content, encoding } = await window.easycode.readFile(filePath, {
      autoDetectEncoding: this.settings.autoDetectEncoding,
    });
    const name = filePath.split(/[/\\]/).pop() || filePath;
    const language = this.settings.autoDetectLanguage
      ? languageFromPath(filePath)
      : "plaintext";
    const tab: EditorTab = {
      id: `file:${filePath}`,
      path: filePath,
      name,
      content,
      original: content,
      dirty: false,
      language,
      encoding,
      view: "code",
    };
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.render();
    await this.lsp.didOpen(filePath, language, content);
  }

  private async saveActive(): Promise<void> {
    const tab = this.activeTab();
    if (!tab || tab.view === "diff" || !tab.dirty) return;
    await window.easycode.writeFile(tab.path, tab.content, tab.encoding || "utf-8");
    tab.original = tab.content;
    tab.dirty = false;
    await this.lsp.didSave(tab.path, tab.content);
    this.renderTabs();
    this.renderStatus();
    this.renderTitlebar();
  }

  private async closeTab(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) {
      const ok = window.confirm(`${tab.name} 有未保存更改，仍要关闭吗？`);
      if (!ok) return;
    }
    if (tab.view !== "diff") {
      await this.lsp.didClose(tab.path);
    }
    const idx = this.tabs.findIndex((t) => t.id === id);
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
    }
    this.render();
  }

  private async runCompare(): Promise<void> {
    const a = this.settings.compareDirA?.trim();
    const b = this.settings.compareDirB?.trim();
    if (!a || !b) {
      this.showToast("请先选择目录 A 和目录 B", true);
      return;
    }
    this.compareBusy = true;
    this.renderSidebarBody();
    try {
      const result = await window.easycode.compareRun(a, b, {
        ignoreWhitespace: this.settings.ignoreWhitespace,
      });
      this.compareResult = result;
      if (result.error) this.showToast(result.error, true);
      await window.easycode.setSettings({
        compareDirA: a,
        compareDirB: b,
        ignoreWhitespace: this.settings.ignoreWhitespace,
      });
    } catch (err) {
      this.showToast(String(err), true);
    } finally {
      this.compareBusy = false;
      this.renderSidebarBody();
    }
  }

  private openChange(change: FileChange): void {
    this.activeChangeRel = change.rel;
    const left = (change.lines_a || []).join("\n");
    const right = (change.lines_b || []).join("\n");
    const id = `diff:${change.rel}`;
    let tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      tab = {
        id,
        path: change.path_b || change.path_a || change.rel,
        name: change.rel,
        content: right,
        original: left,
        dirty: false,
        language: languageFromPath(change.rel),
        encoding: "utf-8",
        view: "diff",
        diff: {
          original: left,
          modified: right,
          originalPath: change.path_a || undefined,
          modifiedPath: change.path_b || undefined,
        },
      };
      this.tabs.push(tab);
    } else {
      tab.diff = {
        original: left,
        modified: right,
        originalPath: change.path_a || undefined,
        modifiedPath: change.path_b || undefined,
      };
    }
    this.activeTabId = tab.id;
    this.render();
  }

  private commands() {
    return [
      { id: "openFolder", title: "打开文件夹", run: () => void this.openFolder() },
      { id: "save", title: "保存当前文件", run: () => void this.saveActive() },
      {
        id: "installExtension",
        title: "从文件夹安装扩展…",
        run: () => void this.installExtension(),
      },
      {
        id: "toggleSidebar",
        title: "切换侧栏可见性",
        run: () => void this.toggleSidebar(),
      },
      {
        id: "togglePanel",
        title: "切换底栏可见性",
        run: () => void this.togglePanel(),
      },
      {
        id: "toggleRight",
        title: "切换右侧栏可见性",
        run: () => void this.toggleRightSidebar(),
      },
      {
        id: "term.powershell",
        title: "新建终端：PowerShell",
        run: () => void this.openTerminal("powershell"),
      },
      {
        id: "term.cmd",
        title: "新建终端：CMD",
        run: () => void this.openTerminal("cmd"),
      },
      {
        id: "term.gitbash",
        title: "新建终端：Git Bash",
        run: () => void this.openTerminal("gitbash"),
      },
      {
        id: "explorer",
        title: "转到：资源管理器",
        run: () => {
          this.activity = "explorer";
          this.render();
        },
      },
      {
        id: "compare",
        title: "转到：比对",
        run: () => {
          this.activity = "compare";
          this.render();
        },
      },
      {
        id: "settings",
        title: "转到：设置",
        run: () => {
          this.activity = "settings";
          this.render();
        },
      },
      {
        id: "extensions",
        title: "转到：扩展",
        run: () => {
          this.activity = "extensions";
          this.render();
        },
      },
      {
        id: "lsp.restart",
        title: "重启语言服务器",
        run: async () => {
          const r = await window.easycode.lspRestart();
          this.applyLspStatus(r);
          this.showToast(
            r.running
              ? `语言服务器已重启${r.servers?.length ? "：" + r.servers.join(", ") : ""}`
              : "没有正在运行的语言服务器",
            !r.running,
          );
          this.renderStatus();
        },
      },
      {
        id: "compare.run",
        title: "运行目录比对",
        run: () => {
          this.activity = "compare";
          this.render();
          void this.runCompare();
        },
      },
    ];
  }

  private toggleCommandPalette(open?: boolean): void {
    this.commandOpen = open ?? !this.commandOpen;
    this.commandFilter = "";
    this.commandIndex = 0;
    this.renderCommandPalette();
  }

  private render(): void {
    if (this.terminalPanel) {
      this.terminalPanel.dispose();
      this.terminalPanel = null;
    }
    this.disposeEditors();

    const noSidebar = !this.settings.showSidebar ? " no-sidebar" : "";
    const noPanel = !this.settings.showPanel ? " no-panel" : "";
    const noRight = !this.settings.showRightSidebar ? " no-right" : "";
    const panelH = this.settings.panelHeight || 220;

    this.root.innerHTML = `
      <div class="shell${noSidebar}${noPanel}${noRight}">
        <div class="titlebar"></div>
        <div class="shell-body">
          <div class="workspace">
            <div class="activity"></div>
            <div class="sidebar">
              <div class="sidebar-header"></div>
              <div class="sidebar-body"></div>
            </div>
            <div class="main">
              <div class="tabs"></div>
              <div class="editor-host"></div>
            </div>
            <div class="rightbar">
              <div class="rightbar-header">大纲</div>
              <div class="rightbar-body"></div>
            </div>
          </div>
          <div class="bottom-panel" style="--panel-h: ${panelH}px">
            <div class="panel-tabs"></div>
            <div class="term-host" id="term-host"></div>
          </div>
        </div>
        <div class="status"></div>
      </div>
    `;
    this.applyLayoutClasses();
    this.renderTitlebar();
    this.renderActivity();
    this.renderSidebarHeader();
    this.renderSidebarBody();
    this.renderTabs();
    this.renderEditorHost();
    this.renderRightbar();
    if (this.settings.showPanel) {
      this.ensureTerminalPanel();
    }
    this.renderPanelTabs();
    this.renderStatus();
    this.renderCommandPalette();
  }

  private renderTitlebar(): void {
    const el = this.root.querySelector(".titlebar");
    if (!el) return;
    el.innerHTML = `
      <div class="brand">Easycode</div>
      <button type="button" data-act="open">打开文件夹</button>
      <button type="button" data-act="save" ${this.activeTab()?.dirty ? "" : "disabled"}>保存</button>
      <div class="spacer"></div>
      <div class="layout-btns">
        <button type="button" data-act="toggle-sidebar" class="${
          this.settings.showSidebar ? "active" : ""
        }">侧栏</button>
        <button type="button" data-act="toggle-panel" class="${
          this.settings.showPanel ? "active" : ""
        }">底栏</button>
        <button type="button" data-act="toggle-right" class="${
          this.settings.showRightSidebar ? "active" : ""
        }">右侧</button>
      </div>
      <div class="term-menu">
        <button type="button" data-act="term-toggle">终端 ▾</button>
        <div class="drop">
          <button type="button" data-shell="powershell">PowerShell</button>
          <button type="button" data-shell="cmd">CMD</button>
          <button type="button" data-shell="gitbash">Git Bash</button>
        </div>
      </div>
      <button type="button" data-act="palette">命令面板</button>
    `;
    el.querySelector('[data-act="open"]')!.addEventListener("click", () => void this.openFolder());
    el.querySelector('[data-act="save"]')!.addEventListener("click", () => void this.saveActive());
    el.querySelector('[data-act="toggle-sidebar"]')!.addEventListener("click", () =>
      void this.toggleSidebar(),
    );
    el.querySelector('[data-act="toggle-panel"]')!.addEventListener("click", () =>
      void this.togglePanel(),
    );
    el.querySelector('[data-act="toggle-right"]')!.addEventListener("click", () =>
      void this.toggleRightSidebar(),
    );
    const termMenu = el.querySelector(".term-menu") as HTMLElement;
    el.querySelector('[data-act="term-toggle"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      termMenu.classList.toggle("open");
    });
    termMenu.querySelectorAll<HTMLButtonElement>("[data-shell]").forEach((btn) => {
      btn.addEventListener("click", () => {
        termMenu.classList.remove("open");
        void this.openTerminal(btn.getAttribute("data-shell") as ShellKind);
      });
    });
    document.addEventListener(
      "click",
      () => termMenu.classList.remove("open"),
      { once: true },
    );
    el.querySelector('[data-act="palette"]')!.addEventListener("click", () =>
      this.toggleCommandPalette(true),
    );
  }

  private renderPanelTabs(): void {
    const el = this.root.querySelector(".panel-tabs") as HTMLElement | null;
    if (!el) return;
    const tabs = this.terminalPanel?.getTabs() || [];
    const active = tabs.find((t) => t.active);
    el.innerHTML = `
      <span class="label">TERMINAL</span>
      ${tabs
        .map(
          (t) =>
            `<button type="button" class="term-tab ${t.active ? "active" : ""}" data-term="${escapeAttr(
              t.id,
            )}">${escapeHtml(t.title)}</button>`,
        )
        .join("")}
      <div class="spacer"></div>
      ${
        active
          ? `<button type="button" data-act="kill-term" title="关闭终端">×</button>`
          : ""
      }
      <div class="term-menu panel-new">
        <button type="button" data-act="new-term">+</button>
        <div class="drop">
          <button type="button" data-shell="powershell">PowerShell</button>
          <button type="button" data-shell="cmd">CMD</button>
          <button type="button" data-shell="gitbash">Git Bash</button>
        </div>
      </div>
    `;
    el.querySelectorAll<HTMLElement>("[data-term]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.terminalPanel?.activate(btn.getAttribute("data-term")!);
        this.renderPanelTabs();
      });
    });
    el.querySelector('[data-act="kill-term"]')?.addEventListener("click", async () => {
      if (!active) return;
      await this.terminalPanel?.close(active.id);
      this.renderPanelTabs();
    });
    const newMenu = el.querySelector(".panel-new") as HTMLElement | null;
    el.querySelector('[data-act="new-term"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      newMenu?.classList.toggle("open");
    });
    newMenu?.querySelectorAll<HTMLButtonElement>("[data-shell]").forEach((btn) => {
      btn.addEventListener("click", () => {
        newMenu.classList.remove("open");
        void this.openTerminal(btn.getAttribute("data-shell") as ShellKind);
      });
    });
  }

  private renderRightbar(): void {
    const el = this.root.querySelector(".rightbar-body") as HTMLElement | null;
    if (!el) return;
    const tab = this.activeTab();
    if (!tab) {
      el.innerHTML = `<div class="empty-hint">无活动文件</div>`;
      return;
    }
    el.innerHTML = `
      <div style="padding:8px 10px;font-size:12px;line-height:1.6">
        <div style="font-weight:600;color:var(--ink)">${escapeHtml(tab.name)}</div>
        <div style="color:var(--muted);margin-top:8px">语言：${escapeHtml(tab.language)}</div>
        <div style="color:var(--muted)">编码：${escapeHtml(
          (tab.encoding || "utf-8").toUpperCase(),
        )}</div>
        <div class="empty-hint" style="margin-top:12px;padding:0">后续可放大纲/问题</div>
      </div>
    `;
  }

  private renderActivity(): void {
    const el = this.root.querySelector(".activity")!;
    const items: { id: ActivityId; label: string; title: string }[] = [
      { id: "explorer", label: "📁", title: "资源管理器" },
      { id: "compare", label: "⇄", title: "比对" },
      { id: "extensions", label: "🧩", title: "扩展" },
      { id: "settings", label: "⚙", title: "设置" },
    ];
    el.innerHTML = items
      .map(
        (i) =>
          `<button type="button" title="${i.title}" data-id="${i.id}" class="${
            this.activity === i.id ? "active" : ""
          }">${i.label}</button>`,
      )
      .join("");
    el.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activity = btn.getAttribute("data-id") as ActivityId;
        this.renderActivity();
        this.renderSidebarHeader();
        this.renderSidebarBody();
      });
    });
  }

  private renderSidebarHeader(): void {
    const el = this.root.querySelector(".sidebar-header")!;
    const titles: Record<ActivityId, string> = {
      explorer: "资源管理器",
      compare: "目录比对",
      extensions: "扩展",
      settings: "设置",
    };
    el.textContent = titles[this.activity];
  }

  private renderSidebarBody(): void {
    const el = this.root.querySelector(".sidebar-body") as HTMLElement;
    if (this.activity === "explorer") this.renderExplorer(el);
    else if (this.activity === "compare") this.renderCompareSidebar(el);
    else if (this.activity === "extensions") void this.renderExtensions(el);
    else this.renderSettings(el);
  }

  private renderExplorer(el: HTMLElement): void {
    if (!this.workspace) {
      el.innerHTML = `<div class="empty-hint">打开一个文件夹开始工作。<br/>快捷键 Ctrl+O</div>`;
      return;
    }
    el.innerHTML = "";
    const rootName = this.workspace.split(/[/\\]/).filter(Boolean).pop() || this.workspace;
    const wrap = document.createElement("div");
    wrap.appendChild(this.buildTreeNode(this.workspace, rootName, true));
    el.appendChild(wrap);
  }

  private buildTreeNode(fullPath: string, name: string, isDir: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-item" + (this.activeTab()?.path === fullPath ? " active" : "");
    const twist = document.createElement("span");
    twist.className = "twist";
    if (isDir) {
      twist.textContent = this.expanded.has(fullPath) ? "▾" : "▸";
    } else {
      twist.textContent = "";
    }
    const label = document.createElement("span");
    label.textContent = name;
    row.append(twist, label);
    row.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (isDir) {
        if (this.expanded.has(fullPath)) this.expanded.delete(fullPath);
        else {
          this.expanded.add(fullPath);
          await this.ensureTree(fullPath);
        }
        this.renderSidebarBody();
      } else {
        await this.openFile(fullPath);
      }
    });

    const container = document.createElement("div");
    container.appendChild(row);
    if (isDir && this.expanded.has(fullPath)) {
      const kids = this.treeCache.get(fullPath);
      if (!kids) {
        void this.ensureTree(fullPath);
      } else {
        const childWrap = document.createElement("div");
        childWrap.className = "tree-children";
        for (const kid of kids) {
          childWrap.appendChild(this.buildTreeNode(kid.path, kid.name, kid.isDirectory));
        }
        container.appendChild(childWrap);
      }
    }
    return container;
  }

  private renderCompareSidebar(el: HTMLElement): void {
    el.innerHTML = `
      <div class="sidebar-actions">
        <div class="panel-form" style="padding:0;width:100%">
          <label>目录 A
            <div class="row">
              <input type="text" id="cmp-a" value="${escapeAttr(this.settings.compareDirA || "")}" />
              <button type="button" id="pick-a">…</button>
            </div>
          </label>
          <label>目录 B
            <div class="row">
              <input type="text" id="cmp-b" value="${escapeAttr(this.settings.compareDirB || "")}" />
              <button type="button" id="pick-b">…</button>
            </div>
          </label>
          <label style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="cmp-ws" ${this.settings.ignoreWhitespace ? "checked" : ""} />
            忽略空白
          </label>
          <button type="button" class="primary" id="cmp-run" ${this.compareBusy ? "disabled" : ""}>
            ${this.compareBusy ? "比对中…" : "开始比对"}
          </button>
        </div>
      </div>
      <div id="cmp-list"></div>
    `;
    const aInput = el.querySelector("#cmp-a") as HTMLInputElement;
    const bInput = el.querySelector("#cmp-b") as HTMLInputElement;
    const ws = el.querySelector("#cmp-ws") as HTMLInputElement;
    el.querySelector("#pick-a")!.addEventListener("click", async () => {
      const p = await window.easycode.pickFolder();
      if (p) {
        aInput.value = p;
        this.settings.compareDirA = p;
      }
    });
    el.querySelector("#pick-b")!.addEventListener("click", async () => {
      const p = await window.easycode.pickFolder();
      if (p) {
        bInput.value = p;
        this.settings.compareDirB = p;
      }
    });
    el.querySelector("#cmp-run")!.addEventListener("click", () => {
      this.settings.compareDirA = aInput.value.trim();
      this.settings.compareDirB = bInput.value.trim();
      this.settings.ignoreWhitespace = ws.checked;
      void this.runCompare();
    });

    const list = el.querySelector("#cmp-list")!;
    if (!this.compareResult) {
      list.innerHTML = `<div class="empty-hint">选择两个目录后开始比对。<br/>引擎：E:\\tools\\compare</div>`;
      return;
    }
    if (!this.compareResult.changes.length) {
      list.innerHTML = `<div class="empty-hint">无差异（在忽略规则下）。</div>`;
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "change-list";
    for (const c of this.compareResult.changes) {
      const li = document.createElement("li");
      if (c.rel === this.activeChangeRel) li.classList.add("active");
      li.innerHTML = `<span class="kind ${c.kind}">${KIND_LABEL[c.kind] || c.kind}</span><span>${escapeHtml(c.rel)}</span>`;
      li.addEventListener("click", () => this.openChange(c));
      ul.appendChild(li);
    }
    list.appendChild(ul);
    const summary = document.createElement("div");
    summary.className = "empty-hint";
    summary.textContent = `仅A=${this.compareResult.only_a} 仅B=${this.compareResult.only_b} 共同=${this.compareResult.common}`;
    list.appendChild(summary);
  }

  private async renderExtensions(el: HTMLElement): Promise<void> {
    this.plugins = await window.easycode.listPlugins();
    const actions = document.createElement("div");
    actions.className = "sidebar-actions";
    actions.innerHTML = `<button type="button" class="primary" id="ext-install">从文件夹安装…</button>`;
    el.innerHTML = "";
    el.appendChild(actions);
    actions.querySelector("#ext-install")!.addEventListener("click", () => void this.installExtension());

    if (!this.plugins.length) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "未发现扩展（extensions/）";
      el.appendChild(hint);
      return;
    }

    for (const p of this.plugins) {
      const item = document.createElement("div");
      item.className = "plugin-item";
      item.dataset.id = p.id;
      item.innerHTML = `
        <h4>${escapeHtml(p.name)} <small style="color:var(--muted)">${escapeHtml(p.version || "")}</small></h4>
        <p>${escapeHtml(p.description || "")}</p>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)">
          <input type="checkbox" data-enable="${escapeAttr(p.id)}" ${p.enabled ? "checked" : ""} />
          启用
        </label>
        ${
          p.installed
            ? `<button type="button" data-uninstall="${escapeAttr(p.id)}" style="margin-top:8px">卸载</button>`
            : ""
        }
      `;
      el.appendChild(item);
    }

    el.querySelectorAll<HTMLInputElement>("[data-enable]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.getAttribute("data-enable")!;
        this.plugins = await window.easycode.setPluginEnabled(id, input.checked);
        const st = await window.easycode.lspRestart();
        this.applyLspStatus(st);
        this.renderStatus();
        this.showToast(`${id} 已${input.checked ? "启用" : "禁用"}`);
      });
    });

    el.querySelectorAll<HTMLButtonElement>("[data-uninstall]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-uninstall")!;
        const ok = window.confirm(`确定卸载扩展「${id}」吗？`);
        if (!ok) return;
        this.plugins = await window.easycode.uninstallPlugin(id);
        const st = await window.easycode.lspRestart();
        this.applyLspStatus(st);
        this.renderStatus();
        this.showToast(`已卸载 ${id}`);
        this.renderSidebarBody();
      });
    });
  }

  private renderSettings(el: HTMLElement): void {
    const dt = this.settings.defaultTerminal || "powershell";
    el.innerHTML = `
      <div class="panel-form">
        <label class="checkbox-row">
          <input type="checkbox" id="set-autoSave" ${this.settings.autoSave ? "checked" : ""} />
          自动保存
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="set-autoLang" ${
            this.settings.autoDetectLanguage ? "checked" : ""
          } />
          自动识别语言
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="set-autoEnc" ${
            this.settings.autoDetectEncoding ? "checked" : ""
          } />
          自动识别编码
        </label>
        <label>默认终端
          <select id="set-defaultTerm">
            <option value="powershell" ${dt === "powershell" ? "selected" : ""}>PowerShell</option>
            <option value="cmd" ${dt === "cmd" ? "selected" : ""}>CMD</option>
            <option value="gitbash" ${dt === "gitbash" ? "selected" : ""}>Git Bash</option>
          </select>
        </label>
        <label>字号
          <input type="number" id="set-fontSize" min="10" max="28" value="${this.settings.fontSize}" />
        </label>
        <label>字体
          <input type="text" id="set-fontFamily" value="${escapeAttr(this.settings.fontFamily)}" />
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="set-wrap" ${this.settings.wordWrap ? "checked" : ""} />
          自动换行
        </label>
        <label>clangd 命令路径 — 由 clangd 扩展使用，非编辑器内置
          <input type="text" id="set-clangd" value="${escapeAttr(this.clangdCommand())}" />
        </label>
        <label>Python 路径
          <input type="text" id="set-python" value="${escapeAttr(this.settings.pythonPath)}" />
        </label>
        <label>compare 根目录
          <input type="text" id="set-compare" value="${escapeAttr(this.settings.compareRoot)}" />
        </label>
        <button type="button" class="primary" id="set-save">保存设置</button>
      </div>
    `;
    el.querySelector("#set-save")!.addEventListener("click", async () => {
      const clangdCommand =
        (el.querySelector("#set-clangd") as HTMLInputElement).value.trim() || "clangd";
      const patch: Partial<AppSettings> = {
        autoSave: (el.querySelector("#set-autoSave") as HTMLInputElement).checked,
        autoDetectLanguage: (el.querySelector("#set-autoLang") as HTMLInputElement).checked,
        autoDetectEncoding: (el.querySelector("#set-autoEnc") as HTMLInputElement).checked,
        defaultTerminal: (el.querySelector("#set-defaultTerm") as HTMLSelectElement)
          .value as ShellKind,
        fontSize: Number((el.querySelector("#set-fontSize") as HTMLInputElement).value) || 14,
        fontFamily: (el.querySelector("#set-fontFamily") as HTMLInputElement).value,
        wordWrap: (el.querySelector("#set-wrap") as HTMLInputElement).checked,
        pythonPath: (el.querySelector("#set-python") as HTMLInputElement).value.trim() || "python",
        compareRoot: (el.querySelector("#set-compare") as HTMLInputElement).value.trim(),
        extensionSettings: {
          ...this.settings.extensionSettings,
          clangd: {
            ...(this.settings.extensionSettings?.clangd || {}),
            command: clangdCommand,
          },
        },
      };
      this.settings = await window.easycode.setSettings(patch);
      this.applyEditorOptions();
      this.showToast("设置已保存");
      this.renderEditorHost();
    });
  }

  private renderTabs(): void {
    const el = this.root.querySelector(".tabs")!;
    if (!this.tabs.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = this.tabs
      .map(
        (t) => `
      <button type="button" class="tab ${t.id === this.activeTabId ? "active" : ""}" data-id="${escapeAttr(t.id)}">
        <span class="${t.dirty ? "dirty" : ""}">${escapeHtml(t.name)}${t.dirty ? " ●" : ""}</span>
        <span class="close" data-close="${escapeAttr(t.id)}">×</span>
      </button>`,
      )
      .join("");
    el.querySelectorAll<HTMLElement>(".tab").forEach((tabEl) => {
      tabEl.addEventListener("click", (e) => {
        const close = (e.target as HTMLElement).getAttribute("data-close");
        if (close) {
          e.stopPropagation();
          void this.closeTab(close);
          return;
        }
        this.activeTabId = tabEl.getAttribute("data-id");
        this.renderTabs();
        this.renderEditorHost();
        this.renderStatus();
        this.renderRightbar();
        this.renderTitlebar();
      });
    });
  }

  private renderEditorHost(): void {
    const host = this.root.querySelector(".editor-host") as HTMLElement;
    const tab = this.activeTab();
    if (!tab) {
      this.disposeEditors();
      host.innerHTML = `<div class="placeholder">打开文件开始编辑<br/><span style="font-size:12px">扩展语言服务 · 目录比对 · 插件</span></div>`;
      return;
    }

    host.innerHTML = `<div class="monaco" id="monaco-root"></div>`;
    this.editorEl = host.querySelector("#monaco-root");

    if (tab.view === "diff" && tab.diff) {
      this.disposeCodeEditor();
      const original = monaco.editor.createModel(
        tab.diff.original,
        tab.language,
        monaco.Uri.parse(pathToUri((tab.diff.originalPath || tab.path) + ".left")),
      );
      const modified = monaco.editor.createModel(
        tab.diff.modified,
        tab.language,
        monaco.Uri.parse(pathToUri((tab.diff.modifiedPath || tab.path) + ".right")),
      );
      this.diffEditor = monaco.editor.createDiffEditor(this.editorEl!, {
        ...this.editorOptions(),
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
      });
      this.diffEditor.setModel({ original, modified });
      return;
    }

    this.disposeDiffEditor();
    const uri = monaco.Uri.file(tab.path);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(tab.content, tab.language, uri);
    } else if (model.getValue() !== tab.content) {
      model.setValue(tab.content);
    }

    if (!this.editor) {
      this.editor = monaco.editor.create(this.editorEl!, {
        model,
        ...this.editorOptions(),
        automaticLayout: true,
      });
      this.editor.onDidChangeCursorPosition((e) => {
        this.cursorLabel = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        this.renderStatus();
      });
      this.editor.onDidChangeModelContent(() => {
        const t = this.activeTab();
        if (!t || t.view === "diff" || !this.editor) return;
        t.content = this.editor.getValue();
        t.dirty = t.content !== t.original;
        this.renderTabs();
        this.renderTitlebar();
        if (this.changeTimer) window.clearTimeout(this.changeTimer);
        this.changeTimer = window.setTimeout(() => {
          void this.lsp.didChange(t.path, t.content);
        }, 300);
        if (this.settings.autoSave) {
          if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
          this.autoSaveTimer = window.setTimeout(() => {
            void this.saveActive();
          }, 1000);
        }
      });
    } else {
      this.editor.setModel(model);
      this.editor.updateOptions(this.editorOptions());
      this.editor.layout();
    }
  }

  private editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
    return {
      theme: "vs-dark",
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      wordWrap: this.settings.wordWrap ? "on" : "off",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
    };
  }

  private applyEditorOptions(): void {
    this.editor?.updateOptions(this.editorOptions());
    this.diffEditor?.updateOptions(this.editorOptions());
  }

  private disposeCodeEditor(): void {
    this.editor?.dispose();
    this.editor = null;
  }

  private disposeDiffEditor(): void {
    this.diffEditor?.dispose();
    this.diffEditor = null;
  }

  private disposeEditors(): void {
    this.disposeCodeEditor();
    this.disposeDiffEditor();
  }

  private renderStatus(): void {
    const el = this.root.querySelector(".status") as HTMLElement;
    if (!el) return;
    const tab = this.activeTab();
    const path = tab?.path || this.workspace || "未打开工作区";
    const lspLabel =
      this.lspRunning && this.lspServers.length
        ? `LSP: ${this.lspServers.join(", ")}`
        : "LSP ○";
    const enc = (tab?.encoding || "utf-8").toUpperCase();
    const lang = tab?.language || "plaintext";
    el.classList.toggle("warn", !this.lspRunning);
    el.innerHTML = `
      <span>${escapeHtml(lspLabel)}</span>
      <span class="grow" title="${escapeAttr(path)}">${escapeHtml(path)}</span>
      <span class="clickable" data-act="encoding" title="更改编码">${escapeHtml(enc)}</span>
      <span>${escapeHtml(lang)}</span>
      <span>${escapeHtml(this.cursorLabel)}</span>
    `;
    el.querySelector('[data-act="encoding"]')?.addEventListener("click", () => {
      const t = this.activeTab();
      if (!t || t.view === "diff") return;
      const next = window.prompt("文件编码（保存时使用）", t.encoding || "utf-8");
      if (!next || !next.trim()) return;
      t.encoding = next.trim();
      this.renderStatus();
      this.renderRightbar();
    });
  }

  private renderCommandPalette(): void {
    document.querySelector(".command-palette")?.remove();
    if (!this.commandOpen) return;
    const cmds = this.commands().filter((c) =>
      c.title.toLowerCase().includes(this.commandFilter.toLowerCase()),
    );
    const overlay = document.createElement("div");
    overlay.className = "command-palette";
    overlay.innerHTML = `
      <div class="box">
        <input type="text" placeholder="输入命令…" value="${escapeAttr(this.commandFilter)}" />
        <ul>
          ${cmds
            .map(
              (c, i) =>
                `<li class="${i === this.commandIndex ? "active" : ""}" data-i="${i}">${escapeHtml(c.title)}</li>`,
            )
            .join("")}
        </ul>
      </div>
    `;
    const input = overlay.querySelector("input")!;
    input.addEventListener("input", () => {
      this.commandFilter = input.value;
      this.commandIndex = 0;
      this.renderCommandPalette();
      const again = document.querySelector(".command-palette input") as HTMLInputElement;
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.commandIndex = Math.min(this.commandIndex + 1, cmds.length - 1);
        this.renderCommandPalette();
        (document.querySelector(".command-palette input") as HTMLInputElement)?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.commandIndex = Math.max(this.commandIndex - 1, 0);
        this.renderCommandPalette();
        (document.querySelector(".command-palette input") as HTMLInputElement)?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = cmds[this.commandIndex];
        this.toggleCommandPalette(false);
        cmd?.run();
      } else if (e.key === "Escape") {
        this.toggleCommandPalette(false);
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.toggleCommandPalette(false);
    });
    overlay.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const i = Number(li.getAttribute("data-i"));
        this.toggleCommandPalette(false);
        cmds[i]?.run();
      });
    });
    document.body.appendChild(overlay);
    input.focus();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const app = new App(document.getElementById("app")!);
void app.start();
