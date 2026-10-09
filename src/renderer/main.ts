// verify-test
import "./styles.css";
import "./monaco.css";
import {
  monaco,
  languageFromPath,
  pathToUri,
  registerEasycodeTheme,
} from "./monacoSetup";
import { LspBridge } from "./lspBridge";
import { TerminalPanel } from "./terminalPanel";
import { countProblems, renderProblemsList, type ProblemItem } from "./problemsPanel";
import {
  accountPlaceholderHtml,
  chatPlaceholderHtml,
  debugPlaceholderHtml,
  loginPopoverHtml,
  outputPlaceholderHtml,
  scmPlaceholderHtml,
  searchPlaceholderHtml,
  tasksPlaceholderHtml,
} from "./placeholderViews";
import { extensionsPanelHtml } from "./extensionsView";
import { SourceControlPanel } from "./sourceControl";
import type {
  ActivityId,
  AgentEventPayload,
  AppSettings,
  ChatMessage,
  EditorTab,
  PanelView,
  ShellKind,
} from "./types";

class App {
  private root: HTMLElement;
  private settings!: AppSettings;
  private activity: ActivityId = "explorer";
  private scmPanel = new SourceControlPanel({
    getWorkspace: () => this.workspace,
    showToast: (m) => this.showToast(m),
    onOpenDiff: (p, s) => void this.openDiffTab(p, s),
  });
  private workspace = "";
  private tabs: EditorTab[] = [];
  private gitFileStatus = new Map<string, string>();
  private editorDecorations: string[] = [];
  private activeTabId: string | null = null;
  private expanded = new Set<string>();
  private treeCache = new Map<string, Awaited<ReturnType<typeof window.easycode.listDir>>>();
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
  private windowMaximized = false;
  private titleMenuOpen: string | null = null;
  private ignoringModelChange = false;
  private accountPopOpen = false;
  private manageMenuOpen = false;
  private settingsOpen = false;
  private settingsCategory = "common";
  private settingsFilter = "";
  private panelResizeCleanup: (() => void) | null = null;
  private extStatusItems: import("./types").StatusBarItemDto[] = [];
  private extOutputChannels: import("./types").OutputChannelDto[] = [];
  private extActiveOutputId: string | null = null;
  private extCommandIds: string[] = [];
  // --- Agent chat ---
  private chatMessages: ChatMessage[] = [];
  private chatRunning = false;
  private chatSessionId: string | null = null;
  private persistSessionId: string | null = null;
  private persistCreatedAt = 0;
  private persistTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.lsp = new LspBridge(
      (m, p) => window.easycode.lspRequest(m, p),
      (m, p) => window.easycode.lspNotify(m, p),
    );
  }

  async start(): Promise<void> {
    this.settings = await window.easycode.getSettings();
    if (!this.settings.panelView) this.settings.panelView = "terminal";
    if (!this.settings.rightView) this.settings.rightView = "info";
    if (!this.settings.configuration) this.settings.configuration = {};
    this.workspace = this.settings.lastWorkspace || "";
    const st = await window.easycode.lspStatus();
    this.applyLspStatus(st);
    this.lsp.registerProviders();
    registerEasycodeTheme();
    monaco.editor.setTheme("easycode-dark");

    window.easycode.onMenu("menu:openFolder", () => void this.openFolder());
    window.easycode.onMenu("menu:save", () => void this.saveActive());
    window.easycode.onMenu("menu:commandPalette", () => this.toggleCommandPalette(true));
    window.easycode.onMenu("menu:togglePanel", () => void this.togglePanel());
    window.easycode.onMenu("menu:toggleSidebar", () => void this.toggleSidebar());
    window.easycode.onMenu("menu:toggleRightSidebar", () => void this.toggleRightSidebar());
    window.easycode.onMenu("menu:newTerminal", (...args) => {
      const kind = (args[0] as ShellKind | undefined) || this.settings.defaultTerminal;
      void this.openTerminal(kind);
    });
    window.easycode.onMenu("menu:about", () =>
      this.showToast("Easycode — 干净的编辑器壳"),
    );
    window.easycode.onLspNotification((data) => {
      this.lsp.handleNotification(data.method, data.params);
      this.refreshProblemsUi();
    });
    window.easycode.onLspStatus((data) => {
      this.applyLspStatus(data);
      this.renderStatus();
    });
    this.windowMaximized = await window.easycode.windowIsMaximized();
    window.easycode.onWindowMaximized((maximized) => {
      this.windowMaximized = maximized;
      this.updateMaximizeButton();
    });
    window.easycode.onFileChanged((data) => void this.handleExternalFileChange(data.path));
    window.easycode.onFileDeleted((data) => void this.handleExternalFileDeleted(data.path));
    window.easycode.onTreeChanged((data) => void this.handleTreeChanged(data.path));

    window.easycode.onExtStatusBar((items) => {
      this.extStatusItems = items;
      this.renderStatus();
      void window.easycode.listExtensionCommands().then((ids) => {
        this.extCommandIds = ids;
      });
    });
    window.easycode.onExtOutput((data) => {
      this.extOutputChannels = data.channels;
      this.extActiveOutputId = data.activeId;
      if (this.settings.showPanel && this.settings.panelView === "output") {
        this.renderBottomPanel();
      }
    });
    window.easycode.onExtMessage((data) => {
      this.showToast(data.text, data.type === "error");
    });
    window.easycode.onExtShowPanel((view) => {
      if (view === "output" || view === "terminal" || view === "problems" || view === "debug") {
        void this.setPanelView(view);
      }
    });
    window.easycode.onExtFocusEditor(() => {
      this.editor?.focus();
    });
    window.easycode.onExtTerminal((ev) => {
      if (ev.action === "created" && ev.kind && ev.title) {
        void this.ensureTerminalPanel();
        this.terminalPanel?.attachExisting({
          id: ev.id,
          kind: ev.kind,
          title: ev.title,
        });
        this.renderPanelChrome();
      } else if (ev.action === "show") {
        void this.setPanelView("terminal");
        this.terminalPanel?.activate(ev.id);
        this.renderPanelChrome();
      } else if (ev.action === "disposed") {
        this.terminalPanel?.removeUiOnly(ev.id);
        this.renderPanelChrome();
      }
    });
    void window.easycode.listExtensionCommands().then((ids) => {
      this.extCommandIds = ids;
    });

    // Agent 事件流 → 聊天消息累积
    window.easycode.onAgentEvent((data) => this.handleAgentEvent(data));
    void this.restoreChatSession();
    window.easycode.onAgentExit((data) => {
      if (data.id === this.chatSessionId) {
        this.chatRunning = false;
        this.chatSessionId = null;
        this.renderRightbar();
      }
    });

    window.addEventListener("keydown", (e) => this.onGlobalKey(e));
    window.addEventListener("resize", () => this.terminalPanel?.layout());
    window.addEventListener("blur", () => {
      if (this.settings.autoSave) void this.saveActive();
    });
    window.addEventListener("focus", () => void this.refreshOpenTabsFromDisk());
    window.addEventListener("click", () => {
      this.closeTitleMenus();
      this.closeAccountPop();
      this.closeManageMenu();
    });
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
        }
        if (!filePath) return false;
        await this.openFile(filePath);
        const ed = this.editor;
        if (ed && selection && "startLineNumber" in selection) {
          ed.setSelection(selection as monaco.Selection);
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
      void window.easycode.watchWorkspace(this.workspace);
    }
  }

  private applyLspStatus(st: { running: boolean; servers?: string[] }): void {
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
    if (e.ctrlKey && e.key === ",") {
      e.preventDefault();
      this.openSettingsModal();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      void this.openActivity("extensions");
    }
    if (e.key === "Escape") {
      if (this.settingsOpen) {
        this.closeSettingsModal();
        return;
      }
      if (this.commandOpen) this.toggleCommandPalette(false);
      this.closeTitleMenus();
      this.closeAccountPop();
      this.closeManageMenu();
    }
  }

  private applyLayoutClasses(): void {
    const shell = this.root.querySelector(".shell");
    if (!shell) return;
    shell.classList.toggle("no-sidebar", !this.settings.showSidebar);
    shell.classList.toggle("no-panel", !this.settings.showPanel);
    shell.classList.toggle("no-right", !this.settings.showRightSidebar);
    const panelH = `${this.settings.panelHeight}px`;
    (shell as HTMLElement).style.setProperty("--panel-h", panelH);
    const sidebarW = `${this.settings.sidebarWidth || 260}px`;
    (shell as HTMLElement).style.setProperty("--sidebar-w", sidebarW);
    const rightbarW = (this.settings.rightbarWidth || 240) + "px";
    (shell as HTMLElement).style.setProperty("--rightbar-w", rightbarW);
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
      this.renderBottomPanel();
      if (this.settings.panelView === "terminal") {
        this.ensureTerminalPanel();
        if (this.terminalPanel && !this.terminalPanel.hasTabs()) {
          await this.terminalPanel.open(this.settings.defaultTerminal);
        }
        this.renderPanelChrome();
        this.terminalPanel?.layout();
      }
    }
  }

  private async toggleRightSidebar(): Promise<void> {
    this.settings = await window.easycode.setSettings({
      showRightSidebar: !this.settings.showRightSidebar,
    });
    this.applyLayoutClasses();
    this.renderTitlebar();
  }

  private async setPanelView(view: PanelView): Promise<void> {
    this.settings = await window.easycode.setSettings({
      panelView: view,
      showPanel: true,
    });
    this.applyLayoutClasses();
    this.renderTitlebar();
    this.renderBottomPanel();
    // 切到终端时自动打开默认终端
    if (view === "terminal" && this.terminalPanel && !this.terminalPanel.hasTabs()) {
      await this.terminalPanel.open(this.settings.defaultTerminal);
      this.renderPanelChrome();
      this.terminalPanel?.layout();
    }
  }

  private async openChatPlaceholder(): Promise<void> {
    this.settings = await window.easycode.setSettings({
      showRightSidebar: true,
      rightView: "chat",
    });
    this.applyLayoutClasses();
    this.renderTitlebar();
    this.renderRightbar();
  }

  private async openTerminal(kind: ShellKind): Promise<void> {
    if (!this.settings.showPanel || this.settings.panelView !== "terminal") {
      await this.setPanelView("terminal");
    }
    this.ensureTerminalPanel();
    await this.terminalPanel?.open(kind);
    this.renderPanelChrome();
    this.terminalPanel?.layout();
  }

  private ensureTerminalPanel(): void {
    const host = this.root.querySelector("#term-host") as HTMLElement | null;
    if (!host) return;
    if (!this.terminalPanel) {
      this.terminalPanel = new TerminalPanel(host);
    }
  }

  private async openFolder(): Promise<void> {
    const folder = await window.easycode.openFolder();
    if (!folder) return;
    this.workspace = folder;
    this.settings = await window.easycode.getSettings();
    this.treeCache.clear();
    this.expanded = new Set([folder]);
    this.activity = "explorer";
    await window.easycode.watchWorkspace(folder);
    this.render();
    void this.refreshGitFileStatus();
    const st = await window.easycode.lspStatus();
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

  private async openFile(filePath: string): Promise<void> {
    const existing = this.tabs.find((t) => this.samePath(t.path, filePath));
    if (existing) {
      this.activeTabId = existing.id;
      if (!existing.dirty) await this.reloadTabFromDisk(existing);
      this.renderTabs();
      this.renderBreadcrumbs();
      this.renderEditorHost();
      this.renderStatus();
      this.renderRightbar();
      if (this.activity === "explorer") this.renderSidebarBody();
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
    };
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    await window.easycode.watchFile(filePath);
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderEditorHost();
    this.renderStatus();
    this.renderRightbar();
    if (this.activity === "explorer") this.renderSidebarBody();
    await this.lsp.didOpen(filePath, language, content);
  }

  private async handleExternalFileChange(filePath: string): Promise<void> {
    const tab = this.tabs.find((t) => this.samePath(t.path, filePath));
    if (!tab) return;
    if (tab.dirty) {
      this.showToast(`${tab.name} 已在外部修改，但本地有未保存更改`, false);
      return;
    }
    if (await this.reloadTabFromDisk(tab)) {
      this.showToast(`已同步外部更改：${tab.name}`);
    }
  }

  private async handleExternalFileDeleted(filePath: string): Promise<void> {
    const victims = this.tabs.filter((t) => this.samePath(t.path, filePath));
    for (const tab of victims) {
      if (tab.dirty) {
        this.showToast(`${tab.name} 已在磁盘上删除，本地仍有未保存内容`, false);
        continue;
      }
      await this.closeTabByPath(tab.path, true);
    }
    await this.invalidateTreeAround(filePath);
  }

  private async handleTreeChanged(changedPath: string): Promise<void> {
    await this.invalidateTreeAround(changedPath);
    for (const tab of [...this.tabs]) {
      if (
        !this.samePath(tab.path, changedPath) &&
        !this.isPathUnder(tab.path, changedPath)
      ) {
        continue;
      }
      const exists = await window.easycode.exists(tab.path);
      if (!exists) {
        if (tab.dirty) {
          this.showToast(`${tab.name} 已在磁盘上删除，本地仍有未保存内容`, false);
        } else {
          await this.closeTabByPath(tab.path, true);
        }
      } else if (!tab.dirty) {
        await this.reloadTabFromDisk(tab);
      }
    }
  }

  private async invalidateTreeAround(changedPath: string): Promise<void> {
    const parent = this.parentDir(changedPath);
    for (const dir of [...this.treeCache.keys()]) {
      if (
        this.samePath(dir, parent) ||
        this.samePath(dir, changedPath) ||
        this.isPathUnder(dir, changedPath)
      ) {
        this.treeCache.delete(dir);
      }
    }
    for (const dir of [...this.expanded]) {
      if (this.samePath(dir, changedPath) || this.isPathUnder(dir, changedPath)) {
        if (!(await window.easycode.exists(dir))) this.expanded.delete(dir);
      }
    }
    if (this.workspace && !this.expanded.has(this.workspace)) {
      this.expanded.add(this.workspace);
    }
    for (const dir of [...this.expanded]) {
      if (!this.treeCache.has(dir)) {
        try {
          this.treeCache.set(dir, await window.easycode.listDir(dir));
        } catch {
          this.expanded.delete(dir);
        }
      }
    }
    if (this.activity === "explorer") this.renderSidebarBody();
  }

  private async refreshOpenTabsFromDisk(): Promise<void> {
    for (const tab of [...this.tabs]) {
      if (tab.dirty) continue;
      const exists = await window.easycode.exists(tab.path);
      if (!exists) await this.closeTabByPath(tab.path, true);
      else await this.reloadTabFromDisk(tab);
    }
    if (this.workspace) await this.invalidateTreeAround(this.workspace);
  }

  private async closeTabByPath(filePath: string, _force: boolean): Promise<void> {
    const tab = this.tabs.find((t) => this.samePath(t.path, filePath));
    if (!tab) return;
    await this.lsp.didClose(tab.path);
    await window.easycode.unwatchFile(tab.path);
    const idx = this.tabs.findIndex((t) => t.id === tab.id);
    this.tabs.splice(idx, 1);
    if (this.activeTabId === tab.id) {
      this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
    }
    this.showToast(`文件已删除：${tab.name}`, false);
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderEditorHost();
    this.renderStatus();
    this.renderRightbar();
    if (this.activity === "explorer") this.renderSidebarBody();
  }

  private async reloadTabFromDisk(tab: EditorTab): Promise<boolean> {
    try {
      if (!(await window.easycode.exists(tab.path))) {
        await this.closeTabByPath(tab.path, true);
        return true;
      }
      const { content, encoding } = await window.easycode.readFile(tab.path, {
        autoDetectEncoding: this.settings.autoDetectEncoding,
        encoding: tab.encoding,
      });
      if (content === tab.content && encoding === tab.encoding) return false;
      tab.content = content;
      tab.original = content;
      tab.encoding = encoding;
      tab.dirty = false;
      const model = monaco.editor.getModel(monaco.Uri.file(tab.path));
      if (model && model.getValue() !== content) {
        this.ignoringModelChange = true;
        try {
          model.setValue(content);
        } finally {
          this.ignoringModelChange = false;
        }
      }
      await this.lsp.didChange(tab.path, content);
      this.renderTabs();
      this.renderStatus();
      if (tab.id === this.activeTabId) this.renderRightbar();
      this.refreshProblemsUi();
      return true;
    } catch {
      return false;
    }
  }

  private samePath(a: string, b: string): boolean {
    return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
  }

  private parentDir(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    if (idx <= 0) return filePath;
    const parent = normalized.slice(0, idx);
    return filePath.includes("\\") ? parent.replace(/\//g, "\\") : parent;
  }

  private isPathUnder(child: string, parent: string): boolean {
    const c = child.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const p = parent.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return c === p || c.startsWith(p + "/");
  }

  private relativePath(filePath: string): string {
    if (!this.workspace) return filePath;
    const w = this.workspace.replace(/\\/g, "/").replace(/\/+$/, "");
    const f = filePath.replace(/\\/g, "/");
    if (f.toLowerCase().startsWith(w.toLowerCase() + "/")) {
      return f.slice(w.length + 1);
    }
    return filePath;
  }

  private async saveActive(): Promise<void> {
    const tab = this.activeTab();
    if (!tab || !tab.dirty) return;
    await window.easycode.writeFile(tab.path, tab.content, tab.encoding || "utf-8");
    tab.original = tab.content;
    tab.dirty = false;
    await this.lsp.didSave(tab.path, tab.content);
    this.renderTabs();
    this.renderStatus();
    if (this.activity === "explorer") this.renderSidebarBody();
    void this.refreshGitFileStatus();
  }

  private async closeTab(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) {
      const ok = window.confirm(`${tab.name} 有未保存更改，仍要关闭吗？`);
      if (!ok) return;
    }
    await this.lsp.didClose(tab.path);
    await window.easycode.unwatchFile(tab.path);
    const idx = this.tabs.findIndex((t) => t.id === id);
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
    }
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderEditorHost();
    this.renderStatus();
    this.renderRightbar();
    if (this.activity === "explorer") this.renderSidebarBody();
    this.refreshProblemsUi();
  }

  private showToast(msg: string, _danger = false): void {
    let el = this.root.querySelector(".toast") as HTMLElement | null;
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      this.root.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el?.classList.remove("show"), 2600);
  }

  private buildCommands(): { id: string; label: string; keys?: string; run: () => void }[] {
    const withKeys = (
      id: string,
      label: string,
      keys: string | undefined,
      run: () => void,
    ) => ({ id, label, keys, run });
    return [
      withKeys("openFolder", "打开文件夹", "Ctrl+O", () => void this.openFolder()),
      withKeys("save", "保存当前文件", "Ctrl+S", () => void this.saveActive()),
      withKeys("toggleSidebar", "切换左侧栏", "Ctrl+B", () => void this.toggleSidebar()),
      withKeys("togglePanel", "切换底栏", "Ctrl+J", () => void this.togglePanel()),
      withKeys("toggleRight", "切换右侧栏", "Ctrl+Alt+B", () => void this.toggleRightSidebar()),
      withKeys("problems", "显示问题", undefined, () => void this.setPanelView("problems")),
      withKeys("terminal", "显示终端", "Ctrl+`", () =>
        void this.openTerminal(this.settings.defaultTerminal),
      ),
      withKeys("chat", "AI 聊天", undefined, () => void this.openChatPlaceholder()),
      withKeys("explorer", "转到：资源管理器", undefined, () => {
        this.activity = "explorer";
        this.render();
      }),
      withKeys("search", "转到：搜索", undefined, () => {
        this.activity = "search";
        this.render();
      }),
      withKeys("settings", "打开设置", "Ctrl+,", () => this.openSettingsModal()),
      ...this.extCommandIds.map((id) =>
        withKeys(`ext:${id}`, id, undefined, () => {
          void window.easycode.executeExtensionCommand(id);
        }),
      ),
    ];
  }

  private toggleCommandPalette(open?: boolean): void {
    this.commandOpen = open ?? !this.commandOpen;
    this.commandFilter = "";
    this.commandIndex = 0;
    this.renderCommandPalette();
  }

  private render(): void {
    this.panelResizeCleanup?.();
    this.panelResizeCleanup = null;
    // 保留终端会话:不 dispose,只把 DOM 元素从旧树摘下,re-render 后重新挂回
    const savedTermViews: { id: string; el: HTMLElement }[] = [];
    if (this.terminalPanel) {
      for (const tab of (this.terminalPanel as any).tabs as any[]) {
        if (tab.el && tab.el.parentNode) {
          tab.el.parentNode.removeChild(tab.el);
          savedTermViews.push({ id: tab.id, el: tab.el });
        }
      }
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
              <div class="sidebar-sash" title="拖拽调整宽度"></div>
            </div>
            <div class="center-column">
              <div class="main">
                <div class="tabs"></div>
                <div class="breadcrumbs"></div>
                <div class="editor-host"></div>
              </div>
              <div class="bottom-panel" style="--panel-h: ${panelH}px">
                <div class="panel-sash" title="拖拽调整高度"></div>
                <div class="panel-chrome"></div>
                <div class="panel-body">
                  <div class="panel-view" id="panel-problems" hidden></div>
                  <div class="panel-view" id="panel-output" hidden></div>
                  <div class="panel-view" id="panel-debug" hidden></div>
                  <div class="panel-view" id="term-host" hidden></div>
                  <div class="term-sidebar" id="term-sidebar" hidden></div>
                </div>
              </div>
            </div>
            <div class="rightbar">
              <div class="rightbar-sash" title="拖拽调整宽度"></div>
              <div class="rightbar-header">聊天</div>
              <div class="rightbar-body"></div>
            </div>
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
    this.renderBreadcrumbs();
    this.renderEditorHost();
    this.renderRightbar();
    this.renderBottomPanel();
    this.bindPanelResize();
    this.bindSidebarResize();
    this.bindRightbarResize();
    // 把存活的终端 DOM 视图重新挂回新的 #term-host 容器
    if (savedTermViews.length && this.terminalPanel) {
      const host = this.root.querySelector("#term-host") as HTMLElement | null;
      if (host) {
        for (const sv of savedTermViews) {
          host.appendChild(sv.el);
        }
        // 切换到当前活动终端可见
        const activeId = (this.terminalPanel as any).activeId;
        if (activeId) this.terminalPanel.activate(activeId);
        // 重新渲染终端侧栏(恢复 term-host 的 right 偏移)
        this.renderTermSidebar();
      }
    }
    this.renderStatus();
    this.renderCommandPalette();
    if (this.settingsOpen) this.renderSettingsModal();
  }

  private renderTitlebar(): void {
    const el = this.root.querySelector(".titlebar");
    if (!el) return;
    const iconSidebar = `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/></svg>`;
    const iconPanel = `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 15h18"/></svg>`;
    const iconRight = `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/></svg>`;
    const iconChat = `<svg viewBox="0 0 24 24"><path d="M4 5h16v10H8l-4 4V5z"/></svg>`;
    const iconAccount = `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 19c1.8-3 4.2-4.5 7-4.5S17.2 16 19 19"/></svg>`;
    const iconMin = `<svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg>`;
    const iconMax = this.windowMaximized
      ? `<svg viewBox="0 0 10 10"><path d="M2.5 3.5h5v5h-5z"/><path d="M3.5 2.5h5v5"/></svg>`
      : `<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>`;
    const iconClose = `<svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>`;

    const workspaceTitle = this.workspace
      ? this.workspace.split(/[/\\]/).filter(Boolean).pop() || "Easycode"
      : "Easycode";

    el.innerHTML = `
      <div class="brand">Easycode</div>
      <nav class="menubar">
        <div class="menu-root" data-menu="file">
          <button type="button" class="menu-trigger" data-menu-trigger="file">文件</button>
          <div class="menu-drop">
            <button type="button" data-cmd="openFolder"><span>打开文件夹</span><kbd>Ctrl+O</kbd></button>
            <button type="button" data-cmd="save"><span>保存</span><kbd>Ctrl+S</kbd></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="soon"><span>自动保存</span></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="quit"><span>退出</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="edit">
          <button type="button" class="menu-trigger" data-menu-trigger="edit">编辑</button>
          <div class="menu-drop">
            <button type="button" data-cmd="soon"><span>撤销</span><kbd>Ctrl+Z</kbd></button>
            <button type="button" data-cmd="soon"><span>恢复</span><kbd>Ctrl+Y</kbd></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="soon"><span>剪切</span><kbd>Ctrl+X</kbd></button>
            <button type="button" data-cmd="soon"><span>复制</span><kbd>Ctrl+C</kbd></button>
            <button type="button" data-cmd="soon"><span>粘贴</span><kbd>Ctrl+V</kbd></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="soon"><span>查找</span><kbd>Ctrl+F</kbd></button>
            <button type="button" data-cmd="soon"><span>替换</span><kbd>Ctrl+H</kbd></button>
          </div>
        </div>
        <div class="menu-root" data-menu="selection">
          <button type="button" class="menu-trigger" data-menu-trigger="selection">选择</button>
          <div class="menu-drop">
            <button type="button" data-cmd="soon"><span>全选</span><kbd>Ctrl+A</kbd></button>
            <button type="button" data-cmd="soon"><span>扩大选区</span></button>
            <button type="button" data-cmd="soon"><span>多光标（即将推出）</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="view">
          <button type="button" class="menu-trigger" data-menu-trigger="view">查看</button>
          <div class="menu-drop">
            <button type="button" data-cmd="palette"><span>命令面板</span><kbd>Ctrl+Shift+P</kbd></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="toggleSidebar"><span>主侧栏</span><kbd>Ctrl+B</kbd></button>
            <button type="button" data-cmd="togglePanel"><span>面板</span><kbd>Ctrl+J</kbd></button>
            <button type="button" data-cmd="toggleRight"><span>聊天侧栏</span></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="panel-problems"><span>问题</span></button>
            <button type="button" data-cmd="panel-output"><span>输出</span></button>
            <button type="button" data-cmd="panel-debug"><span>调试控制台</span></button>
            <button type="button" data-cmd="panel-terminal"><span>终端</span></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="devtools"><span>开发者工具</span></button>
            <button type="button" data-cmd="reload"><span>重新加载</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="go">
          <button type="button" class="menu-trigger" data-menu-trigger="go">转到</button>
          <div class="menu-drop">
            <button type="button" data-cmd="soon"><span>转到文件…</span><kbd>Ctrl+P</kbd></button>
            <button type="button" data-cmd="soon"><span>转到行/列…</span><kbd>Ctrl+G</kbd></button>
            <button type="button" data-cmd="soon"><span>转到符号…</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="run">
          <button type="button" class="menu-trigger" data-menu-trigger="run">运行</button>
          <div class="menu-drop">
            <button type="button" data-cmd="soon"><span>启动调试（即将推出）</span></button>
            <button type="button" data-cmd="soon"><span>运行任务（即将推出）</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="terminal">
          <button type="button" class="menu-trigger" data-menu-trigger="terminal">终端</button>
          <div class="menu-drop">
            <button type="button" data-cmd="togglePanel"><span>切换终端面板</span><kbd>Ctrl+J</kbd></button>
            <div class="menu-sep"></div>
            <button type="button" data-cmd="term-powershell"><span>新建 PowerShell</span></button>
            <button type="button" data-cmd="term-cmd"><span>新建 CMD</span></button>
            <button type="button" data-cmd="term-gitbash"><span>新建 Git Bash</span></button>
          </div>
        </div>
        <div class="menu-root" data-menu="help">
          <button type="button" class="menu-trigger" data-menu-trigger="help">帮助</button>
          <div class="menu-drop">
            <button type="button" data-cmd="about"><span>关于 Easycode</span></button>
          </div>
        </div>
      </nav>
      <div class="titlebar-drag">
        <div class="titlebar-center" title="${escapeAttr(this.workspace || "")}">${escapeHtml(
          workspaceTitle,
        )}</div>
      </div>
      <div class="layout-btns">
        <button type="button" data-act="toggle-sidebar" title="主侧栏" class="${
          this.settings.showSidebar ? "active" : ""
        }">${iconSidebar}</button>
        <button type="button" data-act="toggle-panel" title="面板" class="${
          this.settings.showPanel ? "active" : ""
        }">${iconPanel}</button>
        <button type="button" data-act="toggle-right" title="聊天" class="${
          this.settings.showRightSidebar ? "active" : ""
        }">${iconRight}</button>
      </div>
      <div class="titlebar-actions">
        <button type="button" data-act="chat" title="打开聊天">${iconChat}</button>
        <button type="button" data-act="account" title="帐户">${iconAccount}</button>
      </div>
      <div class="window-controls">
        <button type="button" data-win="min" title="最小化">${iconMin}</button>
        <button type="button" data-win="max" title="${
          this.windowMaximized ? "还原" : "最大化"
        }">${iconMax}</button>
        <button type="button" data-win="close" class="win-close" title="关闭">${iconClose}</button>
      </div>
      <div class="account-pop-host" hidden>${loginPopoverHtml()}</div>
    `;

    if (this.titleMenuOpen) {
      el.querySelector(`.menu-root[data-menu="${this.titleMenuOpen}"]`)?.classList.add("open");
    }
    if (this.accountPopOpen) {
      el.querySelector(".account-pop-host")?.removeAttribute("hidden");
    }

    el.querySelectorAll<HTMLButtonElement>("[data-menu-trigger]").forEach((btn) => {
      const id = btn.getAttribute("data-menu-trigger")!;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleTitleMenu(id);
      });
      btn.addEventListener("mouseenter", () => {
        if (this.titleMenuOpen && this.titleMenuOpen !== id) this.toggleTitleMenu(id, true);
      });
    });
    el.querySelectorAll<HTMLButtonElement>("[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const cmd = btn.getAttribute("data-cmd")!;
        this.closeTitleMenus();
        void this.runTitleCommand(cmd);
      });
    });
    el.querySelector('[data-act="chat"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openChatPlaceholder();
    });
    el.querySelector('[data-act="account"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.accountPopOpen = !this.accountPopOpen;
      this.closeTitleMenus();
      this.renderTitlebar();
    });
    el.querySelector(".account-pop-host")?.addEventListener("click", (e) => e.stopPropagation());
    el.querySelector('[data-act="toggle-sidebar"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleSidebar();
    });
    el.querySelector('[data-act="toggle-panel"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.togglePanel();
    });
    el.querySelector('[data-act="toggle-right"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleRightSidebar();
    });
    el.querySelector('[data-win="min"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void window.easycode.windowMinimize();
    });
    el.querySelector('[data-win="max"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void window.easycode.windowMaximize();
    });
    el.querySelector('[data-win="close"]')!.addEventListener("click", (e) => {
      e.stopPropagation();
      void window.easycode.windowClose();
    });
    el.querySelector(".titlebar-drag")!.addEventListener("dblclick", () => {
      void window.easycode.windowMaximize();
    });
  }

  private toggleTitleMenu(id: string, forceOpen = false): void {
    const el = this.root.querySelector(".titlebar");
    if (!el) return;
    this.accountPopOpen = false;
    const next = forceOpen || this.titleMenuOpen !== id ? id : null;
    this.titleMenuOpen = next;
    el.querySelectorAll(".menu-root").forEach((node) => {
      node.classList.toggle("open", node.getAttribute("data-menu") === next);
    });
    el.querySelector(".account-pop-host")?.setAttribute("hidden", "");
  }

  private closeTitleMenus(): void {
    if (!this.titleMenuOpen) return;
    this.titleMenuOpen = null;
    this.root.querySelectorAll(".menu-root.open").forEach((n) => n.classList.remove("open"));
  }

  private closeAccountPop(): void {
    if (!this.accountPopOpen) return;
    this.accountPopOpen = false;
    this.root.querySelector(".account-pop-host")?.setAttribute("hidden", "");
  }

  private updateMaximizeButton(): void {
    const btn = this.root.querySelector<HTMLButtonElement>('[data-win="max"]');
    if (!btn) return;
    btn.title = this.windowMaximized ? "还原" : "最大化";
    btn.innerHTML = this.windowMaximized
      ? `<svg viewBox="0 0 10 10"><path d="M2.5 3.5h5v5h-5z"/><path d="M3.5 2.5h5v5"/></svg>`
      : `<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>`;
  }

  private async runTitleCommand(cmd: string): Promise<void> {
    switch (cmd) {
      case "openFolder":
        await this.openFolder();
        break;
      case "save":
        await this.saveActive();
        break;
      case "quit":
        await window.easycode.windowClose();
        break;
      case "togglePanel":
        await this.togglePanel();
        break;
      case "term-powershell":
        await this.openTerminal("powershell");
        break;
      case "term-cmd":
        await this.openTerminal("cmd");
        break;
      case "term-gitbash":
        await this.openTerminal("gitbash");
        break;
      case "palette":
        this.toggleCommandPalette(true);
        break;
      case "toggleSidebar":
        await this.toggleSidebar();
        break;
      case "toggleRight":
        await this.toggleRightSidebar();
        break;
      case "panel-problems":
        await this.setPanelView("problems");
        break;
      case "panel-terminal":
        await this.setPanelView("terminal");
        break;
      case "panel-output":
        await this.setPanelView("output");
        break;
      case "panel-debug":
        await this.setPanelView("debug");
        break;
      case "devtools":
        await window.easycode.windowToggleDevTools();
        break;
      case "reload":
        await window.easycode.windowReload();
        break;
      case "about":
        this.showToast("Easycode — 干净的编辑器壳");
        break;
      case "soon":
        this.showToast("即将推出");
        break;
      default:
        break;
    }
  }

  private renderActivity(): void {
    const el = this.root.querySelector(".activity");
    if (!el) return;
    const icons: Record<ActivityId, string> = {
      explorer: `<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v7A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5v-9z"/></svg>`,
      search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>`,
      scm: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6h5.5a4 4 0 0 1 4 4v0"/></svg>`,
      extensions: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>`,
      settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/></svg>`,
      account: `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 19c1.8-3 4.2-4.5 7-4.5S17.2 16 19 19"/></svg>`,
      tasks: `<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
    };
    const top: { id: ActivityId; title: string }[] = [
      { id: "explorer", title: "资源管理器" },
      { id: "search", title: "搜索" },
      { id: "scm", title: "源代码管理" },
      { id: "extensions", title: "扩展" },
    ];
    el.innerHTML = `
      <div class="activity-top">
        ${top
          .map(
            (i) =>
              `<button type="button" title="${i.title}" data-id="${i.id}" class="${
                this.activity === i.id ? "active" : ""
              }">${icons[i.id]}</button>`,
          )
          .join("")}
      </div>
      <div class="activity-bottom">
        <button type="button" title="帐户" data-id="account" class="${
          this.activity === "account" ? "active" : ""
        }">${icons.account}</button>
        <div class="manage-wrap">
          <button type="button" title="管理" data-act="manage" class="${
            this.manageMenuOpen || this.settingsOpen || this.activity === "tasks"
              ? "active"
              : ""
          }">${icons.settings}</button>
          <div class="manage-menu" ${this.manageMenuOpen ? "" : "hidden"}>
            <button type="button" data-manage="settings"><span>设置</span><kbd>Ctrl+,</kbd></button>
            <button type="button" data-manage="extensions"><span>扩展</span><kbd>Ctrl+Shift+X</kbd></button>
            <button type="button" data-manage="tasks"><span>任务</span></button>
          </div>
        </div>
      </div>`;

    el.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeManageMenu();
        void this.openActivity(btn.getAttribute("data-id") as ActivityId);
      });
    });
    el.querySelector('[data-act="manage"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.manageMenuOpen = !this.manageMenuOpen;
      this.renderActivity();
    });
    el.querySelector(".manage-menu")?.addEventListener("click", (e) => e.stopPropagation());
    el.querySelectorAll<HTMLButtonElement>("[data-manage]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.getAttribute("data-manage");
        this.closeManageMenu();
        if (action === "settings") this.openSettingsModal();
        else if (action === "extensions") void this.openActivity("extensions");
        else if (action === "tasks") void this.openActivity("tasks");
      });
    });
  }

  private async openActivity(id: ActivityId): Promise<void> {
    this.activity = id;
    if (!this.settings.showSidebar) {
      this.settings = await window.easycode.setSettings({ showSidebar: true });
      this.applyLayoutClasses();
      this.renderTitlebar();
    }
    this.renderActivity();
    this.renderSidebarHeader();
    this.renderSidebarBody();
  }

  private closeManageMenu(): void {
    if (!this.manageMenuOpen) return;
    this.manageMenuOpen = false;
    this.root.querySelector(".manage-menu")?.setAttribute("hidden", "");
    this.root.querySelector('[data-act="manage"]')?.classList.remove("active");
  }

  private renderSidebarHeader(): void {
    const el = this.root.querySelector(".sidebar-header");
    if (!el) return;
    const titles: Record<ActivityId, string> = {
      explorer: "资源管理器",
      search: "搜索",
      scm: "源代码管理",
      extensions: "扩展",
      settings: "设置",
      account: "帐户",
      tasks: "任务",
    };
    el.textContent = titles[this.activity];
  }

  private renderSidebarBody(): void {
    const el = this.root.querySelector(".sidebar-body") as HTMLElement | null;
    if (!el) return;
    if (this.activity === "explorer") this.renderExplorer(el);
    else if (this.activity === "search") el.innerHTML = searchPlaceholderHtml();
    else if (this.activity === "scm") void this.scmPanel.render(el);
    else if (this.activity === "extensions") void this.renderExtensions(el);
    else if (this.activity === "account") el.innerHTML = accountPlaceholderHtml();
    else if (this.activity === "tasks") el.innerHTML = tasksPlaceholderHtml();
    else if (this.activity === "settings") {
      el.innerHTML = `<div class="placeholder-pane"><p class="placeholder-hint">设置已改为弹窗。可通过齿轮菜单或 Ctrl+, 打开。</p><button type="button" class="primary" id="open-settings-modal">打开设置</button></div>`;
      el.querySelector("#open-settings-modal")?.addEventListener("click", () =>
        this.openSettingsModal(),
      );
    }
  }

  private async renderExtensions(el: HTMLElement): Promise<void> {
    el.innerHTML = `<div class="placeholder-pane"><p class="placeholder-hint">加载中…</p></div>`;
    try {
      const plugins = await window.easycode.listPlugins();
      if (this.activity !== "extensions") return;
      el.innerHTML = extensionsPanelHtml(plugins);
      this.bindExtensionsPanel(el);
    } catch (err) {
      if (this.activity !== "extensions") return;
      const msg = err instanceof Error ? err.message : String(err);
      el.innerHTML = extensionsPanelHtml([], msg);
      this.bindExtensionsPanel(el);
    }
  }

  private bindExtensionsPanel(el: HTMLElement): void {
    const refresh = () => {
      if (this.activity === "extensions") void this.renderExtensions(el);
    };
    el.querySelector("[data-ext-install-vsix]")?.addEventListener("click", () => {
      void (async () => {
        try {
          await window.easycode.installPluginVsix();
          refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          window.alert(`安装失败：${msg}`);
        }
      })();
    });
    el.querySelector("[data-ext-install-folder]")?.addEventListener("click", () => {
      void (async () => {
        try {
          await window.easycode.installPluginFolder();
          refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          window.alert(`安装失败：${msg}`);
        }
      })();
    });
    el.querySelectorAll(".ext-item").forEach((node) => {
      const item = node as HTMLElement;
      const id = item.dataset.id;
      if (!id) return;
      item.querySelector("[data-ext-toggle]")?.addEventListener("change", (ev) => {
        const checked = (ev.target as HTMLInputElement).checked;
        void (async () => {
          try {
            await window.easycode.setPluginEnabled(id, checked);
            refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            window.alert(`更新失败：${msg}`);
            refresh();
          }
        })();
      });
      item.querySelector("[data-ext-uninstall]")?.addEventListener("click", () => {
        if (!window.confirm(`卸载扩展 ${id}？`)) return;
        void (async () => {
          try {
            await window.easycode.uninstallPlugin(id);
            refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            window.alert(`卸载失败：${msg}`);
          }
        })();
      });
    });
  }

  private renderExplorer(el: HTMLElement): void {
    if (!this.workspace) {
      el.innerHTML = `<div class="empty-hint">打开一个文件夹开始工作。<br/>快捷键 Ctrl+O</div>`;
      return;
    }
    const openEditors =
      this.tabs.length > 0
        ? `<div class="explorer-section">
            <div class="section-title">打开的编辑器</div>
            ${this.tabs
              .map(
                (t) =>
                  `<button type="button" class="open-editor ${
                    t.id === this.activeTabId ? "active" : ""
                  }" data-tab="${escapeAttr(t.id)}">${escapeHtml(t.name)}${
                    t.dirty ? " ●" : ""
                  }</button>`,
              )
              .join("")}
          </div>`
        : "";
    el.innerHTML = `${openEditors}<div class="explorer-section"><div class="section-title">工作区</div><div class="tree-root"></div></div>`;
    el.querySelectorAll<HTMLElement>("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTabId = btn.getAttribute("data-tab");
        this.renderTabs();
        this.renderBreadcrumbs();
        this.renderEditorHost();
        this.renderStatus();
        this.renderRightbar();
        this.renderSidebarBody();
      });
    });
    const treeRoot = el.querySelector(".tree-root") as HTMLElement;
    this.renderTreeNode(treeRoot, this.workspace, 0);
  }

  private renderTreeNode(container: HTMLElement, dirPath: string, depth: number): void {
    const kids = this.treeCache.get(dirPath);
    if (!kids) {
      void this.ensureTree(dirPath);
      return;
    }
    for (const entry of kids) {
      const fullPath = entry.path;
      const isDir = entry.isDirectory;
      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const twist = document.createElement("span");
      twist.className = "twist";
      twist.textContent = isDir ? (this.expanded.has(fullPath) ? "▾" : "▸") : "";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "tree-label";
      const rel = this.relPathFromAbs(fullPath);
      const ch = this.gitFileStatus.get(rel);
      const badge = ch ? ` <span class="git-badge git-${ch.toLowerCase()}">${ch}</span>` : "";
      label.innerHTML = `${escapeHtml(entry.name)}${badge}`;
      row.appendChild(twist);
      row.appendChild(label);
      container.appendChild(row);
      label.addEventListener("click", async () => {
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
      if (isDir && this.expanded.has(fullPath)) {
        this.renderTreeNode(container, fullPath, depth + 1);
      }
    }
  }

  private openSettingsModal(category?: string): void {
    this.closeManageMenu();
    this.settingsOpen = true;
    if (category) this.settingsCategory = category;
    this.renderSettingsModal();
    this.renderActivity();
  }

  private closeSettingsModal(): void {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    this.root.querySelector(".settings-modal")?.remove();
    this.renderActivity();
    // 设置可能改了 agentApiKey 等,刷新聊天栏
    this.renderRightbar();
  }

  private renderSettingsModal(): void {
    let overlay = this.root.querySelector(".settings-modal") as HTMLElement | null;
    if (!this.settingsOpen) {
      overlay?.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "settings-modal";
      this.root.appendChild(overlay);
    }

    const cats: { id: string; label: string }[] = [
      { id: "common", label: "常用设置" },
      { id: "editor", label: "文本编辑器" },
      { id: "workbench", label: "工作台" },
      { id: "window", label: "窗口" },
      { id: "chat", label: "聊天" },
      { id: "features", label: "功能" },
      { id: "application", label: "应用程序" },
      { id: "security", label: "安全性" },
      { id: "extensions", label: "扩展" },
    ];
    const filter = this.settingsFilter.trim().toLowerCase();
    const visibleCats = filter
      ? cats.filter((c) => c.label.toLowerCase().includes(filter))
      : cats;
    const active =
      visibleCats.find((c) => c.id === this.settingsCategory)?.id ||
      visibleCats[0]?.id ||
      "common";
    this.settingsCategory = active;
    const catLabel = cats.find((c) => c.id === active)?.label || "设置";

    overlay.innerHTML = `
      <div class="settings-dialog" role="dialog" aria-label="设置">
        <div class="settings-top">
          <div class="settings-title">设置</div>
          <div class="settings-search-wrap">
            <input type="text" id="settings-search" placeholder="搜索设置" value="${escapeAttr(
              this.settingsFilter,
            )}" />
          </div>
          <div class="settings-top-actions">
            <button type="button" class="ghost" data-settings-act="sync" disabled>备份和同步设置</button>
            <button type="button" class="icon-btn" data-settings-act="close" title="关闭">×</button>
          </div>
        </div>
        <div class="settings-tabs">
          <button type="button" class="active">用户</button>
          <button type="button" disabled title="即将推出">工作区</button>
        </div>
        <div class="settings-body">
          <nav class="settings-nav">
            ${visibleCats
              .map(
                (c) =>
                  `<button type="button" class="${
                    c.id === active ? "active" : ""
                  }" data-settings-cat="${c.id}">${escapeHtml(c.label)}</button>`,
              )
              .join("")}
          </nav>
          <div class="settings-content">
            <h2>${escapeHtml(catLabel)}</h2>
            <div class="settings-fields" id="settings-fields"></div>
          </div>
        </div>
      </div>`;

    const fields = overlay.querySelector("#settings-fields") as HTMLElement;
    this.renderSettingsCategory(fields, active);

    overlay.querySelector("#settings-search")?.addEventListener("input", (e) => {
      this.settingsFilter = (e.target as HTMLInputElement).value;
      this.renderSettingsModal();
      const input = this.root.querySelector("#settings-search") as HTMLInputElement | null;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
    overlay.querySelectorAll<HTMLButtonElement>("[data-settings-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.settingsCategory = btn.getAttribute("data-settings-cat") || "common";
        this.renderSettingsModal();
      });
    });
    overlay.querySelector('[data-settings-act="close"]')?.addEventListener("click", () =>
      this.closeSettingsModal(),
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeSettingsModal();
    });
    overlay.querySelector(".settings-dialog")?.addEventListener("click", (e) =>
      e.stopPropagation(),
    );
  }

  private renderSettingsCategory(el: HTMLElement, category: string): void {
    const dt = this.settings.defaultTerminal || "powershell";
    const soon = `<div class="settings-soon">此分类的更多选项即将推出。</div>`;

    if (category === "common") {
      el.innerHTML = `
        <div class="settings-item">
          <div class="settings-item-title">Auto Save</div>
          <div class="settings-item-desc">控制编辑器是否自动保存文件。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-autoSave" ${
            this.settings.autoSave ? "checked" : ""
          } /> 自动保存</label>
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Auto Detect Language</div>
          <div class="settings-item-desc">根据文件扩展名自动识别语言。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-autoLang" ${
            this.settings.autoDetectLanguage ? "checked" : ""
          } /> 自动识别语言</label>
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Auto Detect Encoding</div>
          <div class="settings-item-desc">打开文件时自动识别文本编码。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-autoEnc" ${
            this.settings.autoDetectEncoding ? "checked" : ""
          } /> 自动识别编码</label>
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Default Terminal</div>
          <div class="settings-item-desc">新建终端时使用的默认 Shell。</div>
          <select id="set-defaultTerm">
            <option value="powershell" ${dt === "powershell" ? "selected" : ""}>PowerShell</option>
            <option value="cmd" ${dt === "cmd" ? "selected" : ""}>CMD</option>
            <option value="gitbash" ${dt === "gitbash" ? "selected" : ""}>Git Bash</option>
          </select>
        </div>`;
    } else if (category === "editor") {
      el.innerHTML = `
        <div class="settings-item">
          <div class="settings-item-title">Font Size</div>
          <div class="settings-item-desc">以像素为单位控制字号。</div>
          <input type="number" id="set-fontSize" min="10" max="28" value="${this.settings.fontSize}" />
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Font Family</div>
          <div class="settings-item-desc">控制字体系列。</div>
          <input type="text" id="set-fontFamily" value="${escapeAttr(this.settings.fontFamily)}" />
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Word Wrap</div>
          <div class="settings-item-desc">控制行是否换行。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-wrap" ${
            this.settings.wordWrap ? "checked" : ""
          } /> 自动换行</label>
        </div>`;
    } else if (category === "workbench") {
      el.innerHTML = `
        <div class="settings-item">
          <div class="settings-item-title">Primary Side Bar</div>
          <div class="settings-item-desc">控制主侧栏是否默认可见。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-showSidebar" ${
            this.settings.showSidebar ? "checked" : ""
          } /> 显示主侧栏</label>
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Panel</div>
          <div class="settings-item-desc">控制底部面板是否默认可见。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-showPanel" ${
            this.settings.showPanel ? "checked" : ""
          } /> 显示面板</label>
        </div>
        <div class="settings-item">
          <div class="settings-item-title">Chat Side Bar</div>
          <div class="settings-item-desc">控制聊天侧栏是否默认可见。</div>
          <label class="checkbox-row"><input type="checkbox" id="set-showRight" ${
            this.settings.showRightSidebar ? "checked" : ""
          } /> 显示聊天侧栏</label>
        </div>`;
    } else if (category === "chat") {
      el.innerHTML = `
        <div class="settings-item">
          <div class="settings-item-title">DeepSeek API Key</div>
          <div class="settings-item-desc">
            agent-core 使用的 DeepSeek API Key。获取地址:https://platform.deepseek.com/api-keys
          </div>
          <input type="password" id="set-agentKey" value="${escapeAttr(
            this.settings.agentApiKey || "",
          )}" placeholder="sk-..." style="width:100%;max-width:480px" />
        </div>`;
    } else {
      el.innerHTML = soon;
      return;
    }

    this.bindSettingsFields(el);
  }

  private bindSettingsFields(el: HTMLElement): void {
    const persist = async (patch: Partial<AppSettings>) => {
      this.settings = await window.easycode.setSettings(patch);
      this.applyEditorOptions();
      this.applyLayoutClasses();
      this.renderTitlebar();
      if ("showPanel" in patch && this.settings.showPanel) {
        this.renderBottomPanel();
      }
      if ("agentApiKey" in patch) {
        this.renderRightbar();
      }
    };

    const bindCheck = (id: string, key: keyof AppSettings) => {
      el.querySelector(`#${id}`)?.addEventListener("change", () => {
        const checked = (el.querySelector(`#${id}`) as HTMLInputElement).checked;
        void persist({ [key]: checked } as Partial<AppSettings>);
      });
    };
    bindCheck("set-autoSave", "autoSave");
    bindCheck("set-autoLang", "autoDetectLanguage");
    bindCheck("set-autoEnc", "autoDetectEncoding");
    bindCheck("set-wrap", "wordWrap");
    bindCheck("set-showSidebar", "showSidebar");
    bindCheck("set-showPanel", "showPanel");
    bindCheck("set-showRight", "showRightSidebar");

    el.querySelector("#set-defaultTerm")?.addEventListener("change", () => {
      void persist({
        defaultTerminal: (el.querySelector("#set-defaultTerm") as HTMLSelectElement)
          .value as ShellKind,
      });
    });
    el.querySelector("#set-fontSize")?.addEventListener("change", () => {
      void persist({
        fontSize: Number((el.querySelector("#set-fontSize") as HTMLInputElement).value) || 14,
      });
    });
    el.querySelector("#set-fontFamily")?.addEventListener("change", () => {
      void persist({
        fontFamily: (el.querySelector("#set-fontFamily") as HTMLInputElement).value,
      });
    });
    el.querySelector("#set-agentKey")?.addEventListener("input", () => {
      void persist({
        agentApiKey: (el.querySelector("#set-agentKey") as HTMLInputElement).value,
      });
    });
    // 关闭设置时也兜底保存一次(change 在 blur 时触发,input 可能漏掉最后一次)
    el.querySelector("#set-agentKey")?.addEventListener("change", () => {
      void persist({
        agentApiKey: (el.querySelector("#set-agentKey") as HTMLInputElement).value,
      });
    });
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
  }

  private relPathFromAbs(absPath: string): string {
    const ws = this.normalizePath(this.workspace);
    const p = this.normalizePath(absPath);
    if (!ws) return p;
    if (p === ws) return "";
    if (p.startsWith(ws + "/")) return p.slice(ws.length + 1);
    return p;
  }

  private async refreshGitFileStatus(): Promise<void> {
    if (!this.workspace) {
      this.gitFileStatus.clear();
      this.renderTabs();
      return;
    }
    try {
      const st = (await window.easycode.gitStatus(this.workspace)) as {
        ok: boolean;
        files?: { path: string; index: string; worktree: string; untracked: boolean }[];
      };
      this.gitFileStatus.clear();
      if (st && st.ok && st.files) {
        for (const f of st.files) {
          let ch = "?";
          if (f.untracked) ch = "U";
          else if (f.index === "A") ch = "A";
          else if (f.index === "D" || f.worktree === "D") ch = "D";
          else if (f.index === "R") ch = "R";
          else if (f.index === "M" || f.worktree === "M") ch = "M";
          else ch = f.index !== " " && f.index !== "?" ? f.index : f.worktree;
          this.gitFileStatus.set(this.normalizePath(f.path), ch);
        }
      }
      this.renderTabs();
    } catch {
      /* ignore */
    }
    const t = this.activeTab();
    if (t) setTimeout(() => void this.updateOverviewRuler(t), 80);
  }

  private renderTabs(): void {
    const el = this.root.querySelector(".tabs");
    if (!el) return;
    if (!this.tabs.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = this.tabs
      .map(
        (t) => `
      <button type="button" class="tab ${t.id === this.activeTabId ? "active" : ""}" data-id="${escapeAttr(
        t.id,
      )}">
        <span class="label ${t.dirty ? "dirty" : ""}">${escapeHtml(t.name)}${t.dirty ? " ●" : ""}</span>
        ${(() => { const rel = this.relPathFromAbs(t.path); const ch = this.gitFileStatus.get(rel); return ch ? `<span class="git-badge git-${ch.toLowerCase()}">${ch}</span>` : ""; })()}
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
        this.renderBreadcrumbs();
        this.renderEditorHost();
        this.renderStatus();
        this.renderRightbar();
        if (this.activity === "explorer") this.renderSidebarBody();
      });
    });
  }

  private renderBreadcrumbs(): void {
    const el = this.root.querySelector(".breadcrumbs");
    if (!el) return;
    const tab = this.activeTab();
    if (!tab) {
      el.innerHTML = "";
      return;
    }
    const rel = this.relativePath(tab.path);
    const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
    el.innerHTML = parts.map((p) => `<span class="crumb">${escapeHtml(p)}</span>`).join(
      `<span class="crumb-sep">›</span>`,
    );
  }


  private async openDiffTab(filePath: string, staged: boolean): Promise<void> {
    if (!this.workspace) return;
    const id = `diff:${staged ? "s" : "u"}:${filePath}`;
    const existing = this.tabs.find((t) => t.id === id);
    if (existing) {
      await this.refreshDiffTab(existing);
      this.activeTabId = existing.id;
      this.renderTabs();
      this.renderEditorHost();
      return;
    }
    const baseName = filePath.split(/[\\/]/).pop() || filePath;
    const tab: EditorTab = {
      id,
      path: filePath,
      name: `${baseName} (${staged ? "已暂存" : "更改"})`,
      content: "",
      original: "",
      dirty: false,
      language: languageFromPath(filePath),
      encoding: "utf-8",
      kind: "diff",
      diffStaged: staged,
    };
    await this.refreshDiffTab(tab);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderEditorHost();
    this.renderStatus();
    if (this.activity === "explorer") this.renderSidebarBody();
  }

  private async refreshDiffTab(tab: EditorTab): Promise<void> {
    if (!this.workspace) return;
    const head = await window.easycode.gitShow(this.workspace, "HEAD", tab.path);
    const index = await window.easycode.gitShow(this.workspace, ":0", tab.path);
    if (tab.diffStaged) {
      tab.original = head.ok ? head.content ?? "" : "";
      tab.content = index.ok ? index.content ?? "" : "";
    } else {
      tab.original = index.ok ? index.content ?? "" : "";
      try {
        const res = await window.easycode.readFile(tab.path, {});
        tab.content = res.content;
      } catch {
        tab.content = "";
      }
    }
  }

  private renderDiffTabHost(host: HTMLElement, tab: EditorTab): void {
    this.disposeEditors();
    host.innerHTML = `<div class="monaco" id="diff-root"></div>`;
    const el = host.querySelector("#diff-root") as HTMLElement | null;
    if (!el) return;
    const origUri = monaco.Uri.parse(`easycode-diff-original://${encodeURIComponent(tab.id)}`);
    const modUri = monaco.Uri.parse(`easycode-diff-modified://${encodeURIComponent(tab.id)}`);
    monaco.editor.getModel(origUri)?.dispose();
    monaco.editor.getModel(modUri)?.dispose();
    const originalModel = monaco.editor.createModel(tab.original, tab.language, origUri);
    const modifiedModel = monaco.editor.createModel(tab.content, tab.language, modUri);
    this.diffEditor = monaco.editor.createDiffEditor(el, {
      ...this.editorOptions(),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
    });
    this.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  }

  private async updateOverviewRuler(tab: EditorTab): Promise<void> {
    if (!this.editor || tab.kind === "diff") return;
    await new Promise((r) => setTimeout(r, 80));
    if (!this.editor || this.activeTab()?.id !== tab.id) return;
    if (!this.workspace) {
      if (this.editorDecorations.length) {
        this.editorDecorations = this.editor.deltaDecorations(this.editorDecorations, []);
      }
      return;
    }
    try {
      const res = await window.easycode.gitDiff(this.workspace, tab.path, false);
      if (!res || !res.ok || !res.diff) {
        if (this.editorDecorations.length) {
          this.editorDecorations = this.editor.deltaDecorations(this.editorDecorations, []);
        }
        return;
      }
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      const diffLines = res.diff.split(String.fromCharCode(10));
      let newLine = 0;
      let addStart = -1, addCount = 0, delCount = 0;
      const pushRange = (start: number, count: number, cls: string, color: string) => {
        for (let k = 0; k < count; k++) {
          decorations.push({
            range: new monaco.Range(start + k, 1, start + k, 1),
            options: {
              isWholeLine: false,
              linesDecorationsClassName: cls,
              overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Right },
              minimap: { color, position: monaco.editor.MinimapPosition.Inline },
            },
          });
        }
      };
      const flush = () => {
        if (addCount > 0 && delCount > 0) pushRange(addStart, addCount, "git-modified-gutter", "#58a6ff");
        else if (addCount > 0) pushRange(addStart, addCount, "git-added-gutter", "#3fb950");
        else if (delCount > 0) pushRange(Math.max(1, newLine), 1, "git-deleted-gutter", "#f85149");
        addStart = -1; addCount = 0; delCount = 0;
      };
      for (const ln of diffLines) {
        const m = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) { flush(); newLine = parseInt(m[1], 10); continue; }
        if (ln.startsWith("---") || ln.startsWith("+++")) continue;
        if (ln.startsWith("+")) {
          if (addStart === -1) addStart = newLine;
          addCount++; newLine++;
        } else if (ln.startsWith("-")) {
          delCount++;
        } else if (ln.startsWith(" ")) {
          flush(); newLine++;
        } else {
          flush();
        }
      }
      flush();
      this.editorDecorations = this.editor.deltaDecorations(this.editorDecorations, decorations);
    } catch { /* ignore */ }
  }

  private renderEditorHost(): void {
    const host = this.root.querySelector(".editor-host") as HTMLElement;
    const tab = this.activeTab();
    if (this.diffEditor && (!tab || tab.kind !== "diff")) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }
    if (tab?.kind === "diff") {
      this.renderDiffTabHost(host, tab);
      return;
    }
    if (!tab) {
      this.disposeEditors();
      host.innerHTML = `
        <div class="placeholder">
          <div class="welcome-brand">Easycode</div>
          <div class="welcome-sub">干净的代码编辑器</div>
          <div class="welcome-actions">
            <button type="button" data-welcome="open"><span>打开文件夹</span><kbd>Ctrl+O</kbd></button>
            <button type="button" data-welcome="palette"><span>命令面板</span><kbd>Ctrl+Shift+P</kbd></button>
          </div>
        </div>`;
      host.querySelector('[data-welcome="open"]')?.addEventListener("click", () =>
        void this.openFolder(),
      );
      host.querySelector('[data-welcome="palette"]')?.addEventListener("click", () =>
        this.toggleCommandPalette(true),
      );
      return;
    }

    const editorConnected =
      !!this.editor && this.editor.getContainerDomNode().isConnected;
    if (!editorConnected || host.querySelector(".placeholder") || !host.querySelector("#monaco-root")) {
      if (this.editor) this.disposeEditors();
      host.innerHTML = `<div class="monaco" id="monaco-root"></div>`;
    }
    this.editorEl = host.querySelector("#monaco-root");

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
        if (this.ignoringModelChange) return;
        const t = this.activeTab();
        if (!t || !this.editor) return;
        t.content = this.editor.getValue();
        t.dirty = t.content !== t.original;
        this.renderTabs();
        if (this.activity === "explorer") this.renderSidebarBody();
        if (this.changeTimer) window.clearTimeout(this.changeTimer);
        this.changeTimer = window.setTimeout(() => {
          void this.lsp.didChange(t.path, t.content);
        }, 300);
        this.scheduleAutoSave();
      });
    } else {
      if (this.editor.getModel() !== model) this.editor.setModel(model);
      this.editor.updateOptions(this.editorOptions());
      this.editor.layout();
    }
    void this.updateOverviewRuler(tab);
  }

  private scheduleAutoSave(): void {
    if (!this.settings.autoSave) return;
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => void this.saveActive(), 800);
  }

  private editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
    return {
      theme: "easycode-dark",
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
  }

  private disposeEditors(): void {
    this.editor?.dispose();
    this.editor = null;
    if (this.diffEditor) {
      const m = this.diffEditor.getModel();
      this.diffEditor.dispose();
      m?.original.dispose();
      m?.modified.dispose();
      this.diffEditor = null;
    }
  }

  private renderRightbar(): void {
    this.schedulePersist();
    const body = this.root.querySelector(".rightbar-body") as HTMLElement | null;
    if (!body) return;
    const view = this.settings.rightView || "info";
    if (view !== "chat") {
      body.innerHTML = chatPlaceholderHtml({ withInput: false });
      return;
    }
    body.innerHTML = this.renderChatHtml();
    this.bindChatEvents();
    this.scrollChatToBottom();
  }

  // --- Agent chat rendering & logic ---

  private renderChatHtml(): string {
    const messages = this.chatMessages.length
      ? this.chatMessages
          .map((m) => this.renderChatMessage(m))
          .join("")
      : `<div class="chat-empty">开始新的对话</div>`;
    const apiKeyOk = !!this.settings.agentApiKey;
    const placeholder = apiKeyOk
      ? "描述任务,支持多轮对话。例如:读取 main.ts,然后给它加注释"
      : "请先在设置中填写 DeepSeek API Key";
    const disabled = !apiKeyOk || this.chatRunning;
    const hasHistory = this.chatMessages.length > 0;
    return `
      <div class="chat-pane">
        <div class="chat-stream" data-chat-stream>
          ${messages}
        </div>
        <div class="chat-composer">
          <textarea rows="3" placeholder="${placeholder}" ${
            disabled ? "disabled" : ""
          } data-chat-input></textarea>
          <div class="chat-composer-bar">
            <button type="button" data-chat-clear title="清空对话"${
              hasHistory || this.chatSessionId ? "" : " disabled"
            }>清空</button>
            <button type="button" data-chat-rollback-bar title="回滚本轮改动">回滚</button>
            <div class="spacer"></div>
            ${
              this.chatRunning
                ? '<button type="button" data-chat-stop>停止</button>'
                : '<button type="button" data-chat-send class="primary">发送</button>'
            }
          </div>
        </div>
      </div>`;
  }

  private renderChatMessage(m: ChatMessage): string {
    const esc = escapeHtml;
    if (m.kind === "thinking")
      return `<div class="chat-msg thinking"><span class="chat-icon">💭</span><span>${esc(
        m.text || "",
      )}</span></div>`;
    if (m.kind === "tool_call")
      return `<div class="chat-msg tool-call"><span class="chat-icon">🔧</span><span><b>${esc(
        m.toolName || "",
      )}</b>(${esc(m.toolArgs || "")})</span></div>`;
    if (m.kind === "tool_result")
      return `<div class="chat-msg tool-result"><span class="chat-icon">📄</span><pre class="chat-pre">${esc(
        (m.toolResult || "").slice(0, 500),
      )}</pre></div>`;
    if (m.kind === "verify_result") {
      const ok = (m as unknown as { ok?: boolean }).ok !== false;
      const cls = ok ? "final" : "error";
      const icon = ok ? "✔" : "✘";
      return `<div class="chat-msg ${cls}"><span class="chat-icon">${icon}</span><span>${esc(
        m.text || "",
      )}</span></div>`;
    }
    if (m.kind === "error")
      return `<div class="chat-msg error"><span class="chat-icon">❌</span><span>${esc(
        m.message || m.text || "",
      )}</span></div>`;
    // final
    return `<div class="chat-msg final"><span class="chat-icon">✅</span><span>${esc(
      m.text || "",
    )}</span></div>`;
  }

  private bindChatEvents(): void {
    const body = this.root.querySelector(".rightbar-body");
    if (!body) return;
    const input = body.querySelector("[data-chat-input]") as HTMLTextAreaElement | null;
    const sendBtn = body.querySelector("[data-chat-send]");
    const stopBtn = body.querySelector("[data-chat-stop]");
    const clearBtn = body.querySelector("[data-chat-clear]");
    sendBtn?.addEventListener("click", () => this.sendChatMessage());
    stopBtn?.addEventListener("click", () => this.stopChat());
    clearBtn?.addEventListener("click", () => void this.clearChat());
    body.querySelector("[data-chat-rollback-bar]")?.addEventListener("click", () => void this.rollbackChat());
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
    });
  }

  private scrollChatToBottom(): void {
    const stream = this.root.querySelector("[data-chat-stream]");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  private async sendChatMessage(): Promise<void> {
    const input = this.root.querySelector(
      "[data-chat-input]",
    ) as HTMLTextAreaElement | null;
    if (!input) return;
    const task = input.value.trim();
    if (!task || this.chatRunning) return;
    input.value = "";
    this.chatRunning = true;

    // 显示用户消息
    this.chatMessages.push({ ts: Date.now(), kind: "final", text: `📝 ${task}` });
    this.renderRightbar();

    try {
      if (!this.chatSessionId) {
        // 首条消息:启动交互式会话,会话就绪后自动发送
        this.chatSessionId = await window.easycode.agentStart();
      }
      await window.easycode.agentSend(this.chatSessionId, task);
    } catch (e) {
      this.chatMessages.push({
        ts: Date.now(),
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
      this.chatRunning = false;
      this.chatSessionId = null;
    }
    this.renderRightbar();
  }

  private async restoreChatSession(): Promise<void> {
    try {
      const list = await window.easycode.listSessions();
      if (!list || list.length === 0) return;
      const latest = list[0];
      const data = await window.easycode.loadSession(latest.id);
      if (!data) return;
      this.persistSessionId = data.id;
      this.persistCreatedAt = data.createdAt || Date.now();
      this.chatMessages = (data.messages as ChatMessage[]) || [];
      if (this.settings.rightView === "chat") this.renderRightbar();
    } catch {
      /* restore fail silent */
    }
  }

  private schedulePersist(): void {
    if (this.chatMessages.length === 0) return;
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.persistChat();
    }, 500);
  }

  private async persistChat(): Promise<void> {
    try {
      if (!this.persistSessionId) {
        this.persistSessionId = "sess-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        this.persistCreatedAt = Date.now();
      }
      const firstFinal = this.chatMessages.find((m) => m.kind === "final" && m.text && m.text.length > 2);
      const title = firstFinal?.text ? firstFinal.text.slice(0, 40) : "untitled";
      await window.easycode.saveSession({
        id: this.persistSessionId,
        title,
        createdAt: this.persistCreatedAt,
        updatedAt: Date.now(),
        messages: this.chatMessages,
      });
    } catch {
      /* save fail silent */
    }
  }

  private async clearChat(): Promise<void> {
    if (this.chatSessionId) {
      await window.easycode.agentClear(this.chatSessionId);
    }
    this.chatMessages = [];
    this.chatRunning = false;
    this.persistSessionId = null;
    this.persistCreatedAt = 0;
    this.renderRightbar();
  }

  private stopChat(): void {
    if (this.chatSessionId) void window.easycode.agentStop(this.chatSessionId);
    this.chatRunning = false;
    this.chatSessionId = null;
    this.renderRightbar();
  }

  private async rollbackChat(): Promise<void> {
    const id = this.chatSessionId;
    if (!id) {
      this.showToast("无活动会话，无法回滚");
      return;
    }
    const res = await window.easycode.agentRollback(id);
    if (res.ok) {
      this.showToast("已回滚本轮改动");
      await this.refreshOpenTabsFromDisk();
      if (this.activity === "scm") this.renderSidebarBody();
    } else {
      this.showToast("回滚失败：" + res.message);
    }
  }

  private handleAgentEvent(data: AgentEventPayload): void {
    // session_started / ready: 不显示为消息,只控制状态
    if (data.type === "session_started") return;
    if (data.type === "ready") {
      this.chatRunning = false;
      return;
    }
    if (data.type === "turn_start") return; // 不显示轮次标记
    if (data.type === "verify_result") {
      this.chatMessages.push({
        ts: data.ts * 1000,
        kind: "verify_result",
        text: data.message,
        ok: data.ok,
      } as ChatMessage);
      this.renderRightbar();
      return;
    }

    const m: ChatMessage = {
      ts: data.ts * 1000,
      kind: data.type as ChatMessage["kind"],
      turn: data.turn,
      text: data.content,
      toolName: data.name,
      toolArgs: data.arguments,
      toolResult: data.result,
      message: data.message,
    };
    if (data.type === "final") {
      this.chatRunning = false;
    }
    this.chatMessages.push(m);
    this.renderRightbar();
  }

  private renderBottomPanel(): void {
    this.renderPanelChrome();
    const view = this.settings.panelView || "terminal";
    const map: Record<Exclude<PanelView, "chat">, string> = {
      problems: "panel-problems",
      output: "panel-output",
      debug: "panel-debug",
      terminal: "term-host",
    };
    // Chat lives only in the right sidebar — never in the bottom panel.
    const activeView: Exclude<PanelView, "chat"> =
      view === "chat" ? "terminal" : view;
    for (const [k, id] of Object.entries(map)) {
      const node = this.root.querySelector("#" + id) as HTMLElement | null;
      if (!node) continue;
      const active = k === activeView;
      node.hidden = !active;
      if (active) node.removeAttribute("hidden");
    }

    if (activeView === "problems") {
      const el = this.root.querySelector("#panel-problems") as HTMLElement;
      renderProblemsList(el, (item) => void this.openProblem(item));
    } else if (activeView === "output") {
      const el = this.root.querySelector("#panel-output") as HTMLElement;
      if (this.extOutputChannels.length === 0) {
        el.innerHTML = outputPlaceholderHtml();
      } else {
        const active =
          this.extOutputChannels.find((c) => c.id === this.extActiveOutputId) ||
          this.extOutputChannels[0];
        el.innerHTML = `<div class="ext-output">
          <div class="ext-output-tabs">
            ${this.extOutputChannels
              .map(
                (c) =>
                  `<button type="button" class="${
                    c.id === active.id ? "active" : ""
                  }" data-out="${escapeAttr(c.id)}">${escapeHtml(c.name)}</button>`,
              )
              .join("")}
          </div>
          <pre class="ext-output-body">${escapeHtml(active.content || "")}</pre>
        </div>`;
        el.querySelectorAll<HTMLButtonElement>("[data-out]").forEach((btn) => {
          btn.addEventListener("click", () => {
            this.extActiveOutputId = btn.getAttribute("data-out");
            this.renderBottomPanel();
          });
        });
        const body = el.querySelector(".ext-output-body");
        if (body) body.scrollTop = body.scrollHeight;
      }
    } else if (activeView === "debug") {
      const el = this.root.querySelector("#panel-debug") as HTMLElement;
      el.innerHTML = debugPlaceholderHtml();
    } else if (activeView === "terminal") {
      this.ensureTerminalPanel();
      this.renderPanelChrome();
      // 切到终端时,如果没有标签页,自动打开默认终端
      if (this.terminalPanel && !this.terminalPanel.hasTabs()) {
        void this.terminalPanel.open(this.settings.defaultTerminal).then(() => {
          this.renderPanelChrome();
          this.terminalPanel?.layout();
        });
      } else {
        this.terminalPanel?.layout();
      }
    } else {
      // 非终端视图:隐藏侧栏,重置 term-host 宽度
      const sidebar = this.root.querySelector("#term-sidebar") as HTMLElement | null;
      const termHost = this.root.querySelector("#term-host") as HTMLElement | null;
      if (sidebar) sidebar.hidden = true;
      if (termHost) termHost.style.right = "0";
    }
  }

  private renderPanelChrome(): void {
    const el = this.root.querySelector(".panel-chrome");
    if (!el) return;
    const views: { id: Exclude<PanelView, "chat">; label: string }[] = [
      { id: "problems", label: "问题" },
      { id: "output", label: "输出" },
      { id: "debug", label: "调试控制台" },
      { id: "terminal", label: "终端" },
    ];
    const panelView =
      this.settings.panelView === "chat" ? "terminal" : this.settings.panelView || "terminal";
    const termTabs =
      panelView === "terminal" && this.terminalPanel ? this.terminalPanel.getTabs() : [];
    const activeTerm = termTabs.find((t) => t.active);

    // 面板顶栏:视图切换 + 新建终端按钮(标签移到右侧栏)
    el.innerHTML = `
      <div class="panel-views">
        ${views
          .map(
            (v) =>
              `<button type="button" class="${
                panelView === v.id ? "active" : ""
              }" data-panel="${v.id}">${v.label}</button>`,
          )
          .join("")}
      </div>
      ${
        panelView === "terminal"
          ? `<div class="panel-chrome-right">
              ${
                activeTerm
                  ? `<button type="button" data-act="kill-term" title="关闭当前终端">×</button>`
                  : ""
              }
              <div class="term-menu panel-new">
                <button type="button" data-act="new-term" title="新建终端">+</button>
                <div class="drop">
                  <button type="button" data-shell="powershell">PowerShell</button>
                  <button type="button" data-shell="cmd">CMD</button>
                  <button type="button" data-shell="gitbash">Git Bash</button>
                </div>
              </div>
            </div>`
          : ""
      }`;

    el.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        void this.setPanelView(btn.getAttribute("data-panel") as PanelView);
      });
    });
    el.querySelector('[data-act="kill-term"]')?.addEventListener("click", async () => {
      if (!activeTerm) return;
      await this.terminalPanel?.close(activeTerm.id);
      this.renderPanelChrome();
      this.renderTermSidebar();
      this.terminalPanel?.layout();
    });
    const newMenu = el.querySelector(".panel-new") as HTMLElement | null;
    el.querySelector('[data-act="new-term"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      newMenu?.classList.toggle("open");
    });
    newMenu?.querySelectorAll<HTMLButtonElement>("[data-shell]").forEach((btn) => {
      btn.addEventListener("click", () => {
        newMenu.classList.remove("open");
        void this.openTerminal(btn.getAttribute("data-shell") as ShellKind).then(() => {
          this.renderTermSidebar();
          this.terminalPanel?.layout();
        });
      });
    });

    // 渲染右侧终端标签栏
    this.renderTermSidebar();
  }

  /** 渲染终端面板右侧的标签栏(2+ 终端时显示) */
  private renderTermSidebar(): void {
    const sidebar = this.root.querySelector("#term-sidebar") as HTMLElement | null;
    const termHost = this.root.querySelector("#term-host") as HTMLElement | null;
    if (!sidebar || !termHost) return;

    const isTerminal = this.settings.panelView === "terminal";
    const tabs = isTerminal && this.terminalPanel ? this.terminalPanel.getTabs() : [];
    const showSidebar = isTerminal && tabs.length >= 2;

    if (!showSidebar) {
      sidebar.hidden = true;
      sidebar.removeAttribute("data-visible");
      termHost.style.right = "0";
      return;
    }

    sidebar.hidden = false;
    sidebar.setAttribute("data-visible", "");
    termHost.style.right = "160px"; // 给侧栏腾出空间

    const activeTab = tabs.find((t) => t.active);
    sidebar.innerHTML = `
      <div class="term-sidebar-header">
        <span>终端</span>
      </div>
      <div class="term-sidebar-list">
        ${tabs
          .map(
            (t) => `
            <div class="term-sidebar-item ${t.active ? "active" : ""}" data-term="${escapeAttr(t.id)}">
              <span class="term-sidebar-icon">${t.title === "PowerShell" || t.title === "pwsh" ? "❯" : t.title === "cmd" ? "▣" : "$"}</span>
              <span class="term-sidebar-label">${escapeHtml(t.title)}</span>
              <button type="button" class="term-sidebar-close" data-kill="${escapeAttr(t.id)}" title="关闭">×</button>
            </div>`,
          )
          .join("")}
      </div>
    `;

    sidebar.querySelectorAll<HTMLElement>("[data-term]").forEach((item) => {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).hasAttribute("data-kill")) return;
        this.terminalPanel?.activate(item.getAttribute("data-term")!);
        this.renderPanelChrome();
      });
    });
    sidebar.querySelectorAll<HTMLElement>("[data-kill]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-kill")!;
        void this.terminalPanel?.close(id).then(() => {
          this.renderPanelChrome();
          this.terminalPanel?.layout();
        });
      });
    });
  }

  private bindRightbarResize(): void {
    const sash = this.root.querySelector(".rightbar-sash") as HTMLElement | null;
    if (!sash) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const next = Math.max(160, Math.min(600, startW + delta));
      this.settings.rightbarWidth = next;
      const shell = this.root.querySelector(".shell") as HTMLElement | null;
      if (shell) shell.style.setProperty("--rightbar-w", next + "px");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void window.easycode.setSettings({ rightbarWidth: this.settings.rightbarWidth });
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      startW = this.settings.rightbarWidth || 240;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    sash.addEventListener("mousedown", onDown);
  }

  private bindSidebarResize(): void {
    const sash = this.root.querySelector(".sidebar-sash") as HTMLElement | null;
    if (!sash) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const next = Math.max(160, Math.min(600, startW + delta));
      this.settings.sidebarWidth = next;
      const shell = this.root.querySelector(".shell") as HTMLElement | null;
      if (shell) shell.style.setProperty("--sidebar-w", `${next}px`);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void window.easycode.setSettings({ sidebarWidth: this.settings.sidebarWidth });
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      startW = this.settings.sidebarWidth || 260;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    sash.addEventListener("mousedown", onDown);
  }

  private bindPanelResize(): void {
    const sash = this.root.querySelector(".panel-sash") as HTMLElement | null;
    const panel = this.root.querySelector(".bottom-panel") as HTMLElement | null;
    if (!sash || !panel) return;
    let startY = 0;
    let startH = 0;
    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const next = Math.max(120, Math.min(480, startH + delta));
      this.settings.panelHeight = next;
      panel.style.setProperty("--panel-h", `${next}px`);
      this.terminalPanel?.layout();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void window.easycode.setSettings({ panelHeight: this.settings.panelHeight });
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startH = this.settings.panelHeight || 220;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    sash.addEventListener("mousedown", onDown);
    this.panelResizeCleanup = () => sash.removeEventListener("mousedown", onDown);
  }

  private async openProblem(item: ProblemItem): Promise<void> {
    await this.openFile(item.path);
    const ed = this.editor;
    if (!ed) return;
    ed.setPosition({ lineNumber: item.startLineNumber, column: item.startColumn });
    ed.revealPositionInCenter({
      lineNumber: item.startLineNumber,
      column: item.startColumn,
    });
    ed.focus();
  }

  private refreshProblemsUi(): void {
    this.renderStatus();
    if (this.settings.showPanel && this.settings.panelView === "problems") {
      const el = this.root.querySelector("#panel-problems") as HTMLElement | null;
      if (el) renderProblemsList(el, (item) => void this.openProblem(item));
    }
  }

  private detectEol(text: string): string {
    if (text.includes("\r\n")) return "CRLF";
    if (text.includes("\n")) return "LF";
    return "LF";
  }

  private renderStatus(): void {
    const el = this.root.querySelector(".status");
    if (!el) return;
    const tab = this.activeTab();
    const { errors, warnings } = countProblems();
    const pathLabel = tab?.path || this.workspace || "未打开工作区";
    const lsp =
      this.lspRunning && this.lspServers.length
        ? `<button type="button" class="status-item" data-act="lsp">${escapeHtml(
            this.lspServers.join(", "),
          )}</button>`
        : "";
    const leftExt = this.extStatusItems
      .filter((i) => i.alignment === "left")
      .map(
        (i) =>
          `<button type="button" class="status-item ext-status" data-ext-cmd="${escapeAttr(
            i.command || "",
          )}" title="${escapeAttr(i.tooltip || i.text)}">${escapeHtml(
            formatCodicons(i.text),
          )}</button>`,
      )
      .join("");
    const rightExt = this.extStatusItems
      .filter((i) => i.alignment === "right")
      .map(
        (i) =>
          `<button type="button" class="status-item ext-status" data-ext-cmd="${escapeAttr(
            i.command || "",
          )}" title="${escapeAttr(i.tooltip || i.text)}">${escapeHtml(
            formatCodicons(i.text),
          )}</button>`,
      )
      .join("");
    el.innerHTML = `
      <div class="status-left">
        <button type="button" class="status-item problems-count" data-act="problems" title="问题">
          <span class="err">● ${errors}</span>
          <span class="warn">● ${warnings}</span>
        </button>
        ${leftExt}
        ${lsp}
        <span class="status-item path" title="${escapeAttr(pathLabel)}">${escapeHtml(
          tab ? tab.name : pathLabel,
        )}</span>
      </div>
      <div class="status-right">
        ${rightExt}
        <span class="status-item">${escapeHtml(this.cursorLabel)}</span>
        <span class="status-item">${escapeHtml(tab?.language || "plaintext")}</span>
        <button type="button" class="status-item" data-act="encoding">${escapeHtml(
          (tab?.encoding || "utf-8").toUpperCase(),
        )}</button>
        <span class="status-item">Spaces: 2</span>
        <span class="status-item">${tab ? this.detectEol(tab.content) : "LF"}</span>
        <button type="button" class="status-item" data-act="notify" title="通知（占位）">🔔</button>
      </div>`;
    el.querySelector('[data-act="problems"]')?.addEventListener("click", () =>
      void this.setPanelView("problems"),
    );
    el.querySelectorAll<HTMLButtonElement>("[data-ext-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.getAttribute("data-ext-cmd");
        if (cmd) void window.easycode.executeExtensionCommand(cmd);
      });
    });
    el.querySelector('[data-act="encoding"]')?.addEventListener("click", () => {
      const t = this.activeTab();
      if (!t) return;
      const next = window.prompt("文件编码（保存时使用）", t.encoding || "utf-8");
      if (!next) return;
      t.encoding = next.trim() || "utf-8";
      this.renderStatus();
      this.renderRightbar();
    });
    el.querySelector('[data-act="notify"]')?.addEventListener("click", () =>
      this.showToast("通知中心即将推出"),
    );
  }

  private renderCommandPalette(): void {
    let overlay = this.root.querySelector(".command-palette") as HTMLElement | null;
    if (!this.commandOpen) {
      overlay?.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "command-palette";
      this.root.appendChild(overlay);
    }
    const cmds = this.buildCommands().filter((c) =>
      c.label.toLowerCase().includes(this.commandFilter.toLowerCase()),
    );
    overlay.innerHTML = `
      <div class="palette-box">
        <input type="text" id="palette-input" placeholder="输入命令…" value="${escapeAttr(
          this.commandFilter,
        )}" />
        <div class="palette-list">
          ${cmds
            .map(
              (c, i) =>
                `<button type="button" class="palette-item ${
                  i === this.commandIndex ? "active" : ""
                }" data-idx="${i}"><span>${escapeHtml(c.label)}</span>${
                  c.keys ? `<kbd>${escapeHtml(c.keys)}</kbd>` : ""
                }</button>`,
            )
            .join("")}
        </div>
      </div>`;
    const input = overlay.querySelector("#palette-input") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener("input", () => {
      this.commandFilter = input.value;
      this.commandIndex = 0;
      this.renderCommandPalette();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.commandIndex = Math.min(this.commandIndex + 1, cmds.length - 1);
        this.renderCommandPalette();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.commandIndex = Math.max(this.commandIndex - 1, 0);
        this.renderCommandPalette();
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
    overlay.querySelectorAll<HTMLButtonElement>("[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = cmds[Number(btn.getAttribute("data-idx"))];
        this.toggleCommandPalette(false);
        cmd?.run();
      });
    });
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

const CODICON_MAP: Record<string, string> = {
  tools: "🔨",
  zap: "⚡",
  "radio-tower": "📡",
  "run-all": "▶",
  "file-code": "📑",
  check: "✓",
  "sync~spin": "⟳",
};

function formatCodicons(text: string): string {
  return text.replace(/\$\(([^)]+)\)/g, (_, name: string) => CODICON_MAP[name] || "");
}

const appRoot = document.getElementById("app");
if (appRoot) {
  void new App(appRoot).start();
}
