const fs = require("fs");

function patch(file, ops) {
  let s = fs.readFileSync(file, "utf8");
  for (const [find, replace, label] of ops) {
    if (!s.includes(find)) {
      throw new Error(`[${file}] anchor not found: ${label}`);
    }
    s = s.replace(find, replace);
  }
  fs.writeFileSync(file, s, "utf8");
  console.log("patched " + file);
}

// 1) types.ts — EditorTab 加 kind / diffLabel
patch("src/renderer/types.ts", [
  [
    `export interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  original: string;
  dirty: boolean;
  language: string;
  encoding: string;
}`,
    `export interface EditorTab {
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
}`,
    "EditorTab",
  ],
]);

// 2) git.ts — 追加 gitShow
{
  const p = "src/main/git.ts";
  const s = fs.readFileSync(p, "utf8");
  if (s.includes("export async function gitShow")) {
    console.log("git.ts already has gitShow");
  } else {
    const add = `

export async function gitShow(
  root: string,
  rev: string,
  filePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!root) return { ok: false, error: "no workspace" };
  const res = await runGit(root, ["show", \`\${rev}:\${filePath}\`]);
  if (!res.ok) {
    const low = res.error.toLowerCase();
    if (
      low.includes("does not exist") ||
      low.includes("exists on disk") ||
      low.includes("unknown revision") ||
      low.includes("ambiguous argument")
    ) {
      return { ok: true, content: "" };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, content: res.stdout };
}
`;
    fs.appendFileSync(p, add, "utf8");
    console.log("appended git.ts");
  }
}

// 3) index.ts — import + IPC
patch("src/main/index.ts", [
  [
    'import { gitStatus, gitStage, gitUnstage, gitCommit, gitDiff } from "./git";',
    'import { gitStatus, gitStage, gitUnstage, gitCommit, gitDiff, gitShow } from "./git";',
    "import gitShow",
  ],
  [
    'ipcMain.handle("git:diff", (_e, root: string, path: string, staged: boolean) => gitDiff(root, path, staged));',
    `ipcMain.handle("git:diff", (_e, root: string, path: string, staged: boolean) => gitDiff(root, path, staged));
  ipcMain.handle("git:show", (_e, root: string, rev: string, path: string) => gitShow(root, rev, path));`,
    "git:show ipc",
  ],
]);

// 4) preload.ts — 加 gitShow
patch("src/preload/preload.ts", [
  [
    '  gitDiff: (root: string, path: string, staged: boolean) => ipcRenderer.invoke("git:diff", root, path, staged),',
    `  gitDiff: (root: string, path: string, staged: boolean) => ipcRenderer.invoke("git:diff", root, path, staged),
  gitShow: (root: string, rev: string, path: string) => ipcRenderer.invoke("git:show", root, rev, path),`,
    "gitShow preload",
  ],
]);

// 5) main.ts
patch("src/renderer/main.ts", [
  // diffEditor 字段
  [
    "  private editor: monaco.editor.IStandaloneCodeEditor | null = null;",
    `  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;`,
    "diffEditor field",
  ],
  // scmPanel 回调
  [
    `  private scmPanel = new SourceControlPanel({
    getWorkspace: () => this.workspace,
    showToast: (m) => this.showToast(m),
  });`,
    `  private scmPanel = new SourceControlPanel({
    getWorkspace: () => this.workspace,
    showToast: (m) => this.showToast(m),
    onOpenDiff: (p, s) => void this.openDiffTab(p, s),
  });`,
    "scmPanel deps",
  ],
  // renderEditorHost 开头插入 diff 分支 + 释放 diffEditor
  [
    `  private renderEditorHost(): void {
    const host = this.root.querySelector(".editor-host") as HTMLElement;
    const tab = this.activeTab();
    if (!tab) {`,
    `  private renderEditorHost(): void {
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
    if (!tab) {`,
    "renderEditorHost diff branch",
  ],
]);

// 6) main.ts — 追加 openDiffTab / refreshDiffTab / renderDiffTabHost 方法
// 放在 renderEditorHost 之前，方便同文件定位
{
  const p = "src/renderer/main.ts";
  let s = fs.readFileSync(p, "utf8");
  const anchor = "  private renderEditorHost(): void {";
  if (s.includes("private renderDiffTabHost(")) {
    console.log("main.ts already has renderDiffTabHost");
  } else {
    const methods = `
  private async openDiffTab(filePath: string, staged: boolean): Promise<void> {
    if (!this.workspace) return;
    const id = \`diff:\${staged ? "s" : "u"}:\${filePath}\`;
    const existing = this.tabs.find((t) => t.id === id);
    if (existing) {
      await this.refreshDiffTab(existing);
      this.activeTabId = existing.id;
      this.renderTabs();
      this.renderEditorHost();
      return;
    }
    const baseName = filePath.split(/[\\\\/]/).pop() || filePath;
    const tab: EditorTab = {
      id,
      path: filePath,
      name: \`\${baseName} (\${staged ? "已暂存" : "更改"})\`,
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
    host.innerHTML = \`<div class="monaco" id="diff-root"></div>\`;
    const el = host.querySelector("#diff-root") as HTMLElement | null;
    if (!el) return;
    const originalModel = monaco.editor.createModel(
      tab.original,
      tab.language,
      monaco.Uri.parse(\`easycode-diff-original://\${encodeURIComponent(tab.id)}\`),
    );
    const modifiedModel = monaco.editor.createModel(
      tab.content,
      tab.language,
      monaco.Uri.parse(\`easycode-diff-modified://\${encodeURIComponent(tab.id)}\`),
    );
    this.diffEditor = monaco.editor.createDiffEditor(el, {
      ...this.editorOptions(),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
    });
    this.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  }

`;
    if (!s.includes(anchor)) throw new Error("renderEditorHost anchor missing");
    s = s.replace(anchor, methods + anchor);
    fs.writeFileSync(p, s, "utf8");
    console.log("appended diff methods to main.ts");
  }
}

console.log("all patches applied");