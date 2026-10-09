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

// --- index.ts ---
patch("src/main/index.ts", [
  [
    'import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";',
    'import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";\nimport { gitStatus, gitStage, gitUnstage, gitCommit, gitDiff } from "./git";',
    "import git",
  ],
  [
    'ipcMain.handle("term:list", () => terminalHost?.list() ?? []);',
    [
      'ipcMain.handle("git:status", (_e, root: string) => gitStatus(root));',
      'ipcMain.handle("git:stage", (_e, root: string, paths: string[]) => gitStage(root, paths));',
      'ipcMain.handle("git:unstage", (_e, root: string, paths: string[]) => gitUnstage(root, paths));',
      'ipcMain.handle("git:commit", (_e, root: string, message: string) => gitCommit(root, message));',
      'ipcMain.handle("git:diff", (_e, root: string, path: string, staged: boolean) => gitDiff(root, path, staged));',
      '',
      'ipcMain.handle("term:list", () => terminalHost?.list() ?? []);',
    ].join("\n"),
    "git ipc",
  ],
]);

// --- preload.ts ---
patch("src/preload/preload.ts", [
  [
    '  termKill: (id: string) => ipcRenderer.invoke("term:kill", id),',
    [
      '  termKill: (id: string) => ipcRenderer.invoke("term:kill", id),',
      '  gitStatus: (root: string) => ipcRenderer.invoke("git:status", root),',
      '  gitStage: (root: string, paths: string[]) => ipcRenderer.invoke("git:stage", root, paths),',
      '  gitUnstage: (root: string, paths: string[]) => ipcRenderer.invoke("git:unstage", root, paths),',
      '  gitCommit: (root: string, message: string) => ipcRenderer.invoke("git:commit", root, message),',
      '  gitDiff: (root: string, path: string, staged: boolean) => ipcRenderer.invoke("git:diff", root, path, staged),',
    ].join("\n"),
    "git api",
  ],
]);

// --- main.ts ---
patch("src/renderer/main.ts", [
  [
    'import { extensionsPanelHtml } from "./extensionsView";',
    'import { extensionsPanelHtml } from "./extensionsView";\nimport { SourceControlPanel } from "./sourceControl";',
    "import scm",
  ],
  [
    '  private activity: ActivityId = "explorer";',
    '  private activity: ActivityId = "explorer";\n  private scmPanel = new SourceControlPanel({\n    getWorkspace: () => this.workspace,\n    showToast: (m) => this.showToast(m),\n  });',
    "scm field",
  ],
  [
    'else if (this.activity === "scm") el.innerHTML = scmPlaceholderHtml();',
    'else if (this.activity === "scm") void this.scmPanel.render(el);',
    "scm branch",
  ],
]);