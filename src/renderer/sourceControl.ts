interface GitFile {
    path: string;
    index: string;
    worktree: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  }
  
  interface GitStatusResult {
    ok: boolean;
    error?: string;
    branch?: string;
    files: GitFile[];
  }
  
  interface GitOpResult {
    ok: boolean;
    message: string;
  }
  
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  
  function statusLabel(f: GitFile): string {
    if (f.untracked) return "U";
    if (f.index !== " " && f.index !== "?") return f.index;
    if (f.worktree !== " ") return f.worktree;
    return "?";
  }
  
  export interface SourceControlDeps {
    getWorkspace: () => string;
    showToast: (msg: string) => void;
    onOpenDiff: (filePath: string, staged: boolean) => void;
  }
  
  export class SourceControlPanel {
    private commitMessage = "";
    private status: GitStatusResult | null = null;
    private busy = false;
  
    constructor(private deps: SourceControlDeps) {}
  
    async render(host: HTMLElement): Promise<void> {
      const ws = this.deps.getWorkspace();
      if (!ws) {
        host.innerHTML = `<div class="placeholder-pane"><p class="placeholder-hint">请先打开一个文件夹。</p></div>`;
        return;
      }
      if (this.busy) return;
      this.busy = true;
      try {
        const status = (await window.easycode.gitStatus(ws)) as GitStatusResult;
        this.status = status;
        if (!status.ok) {
          host.innerHTML = `<div class="placeholder-pane"><p class="placeholder-hint">${escapeHtml(
            status.error || "Git 不可用",
          )}</p></div>`;
          return;
        }
        this.renderBody(host);
      } catch (e) {
        host.innerHTML = `<div class="placeholder-pane"><p class="placeholder-hint">读取 Git 状态失败：${escapeHtml(
          String(e),
        )}</p></div>`;
      } finally {
        this.busy = false;
      }
    }
  
    private renderBody(host: HTMLElement): void {
      const status = this.status!;
      const staged = status.files.filter((f) => f.staged);
      const changes = status.files.filter((f) => !f.staged && !f.untracked);
      const untracked = status.files.filter((f) => f.untracked);
      const total = status.files.length;
  
      host.innerHTML = `
        <div class="scm-pane">
          <div class="scm-commit">
            <textarea class="scm-message" rows="3" placeholder="提交信息（Ctrl+Enter 提交）">${escapeHtml(
              this.commitMessage,
            )}</textarea>
            <button type="button" class="primary scm-commit-btn" ${
              staged.length === 0 ? "disabled" : ""
            }>
              提交 (${staged.length})
            </button>
          </div>
          <div class="scm-toolbar">
            <span class="scm-branch">${
              status.branch ? "分支: " + escapeHtml(status.branch) : ""
            }${total === 0 ? " · 工作区干净" : ""}</span>
            <button type="button" class="scm-refresh" title="刷新">↻</button>
          </div>
          ${staged.length ? this.renderSection("已暂存的更改", staged, true) : ""}
          ${changes.length ? this.renderSection("更改", changes, false) : ""}
          ${untracked.length ? this.renderSection("未跟踪", untracked, false) : ""}
        </div>
      `;
  
      const ta = host.querySelector<HTMLTextAreaElement>(".scm-message");
      if (ta) {
        ta.addEventListener("input", () => {
          this.commitMessage = ta.value;
        });
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void this.commit(host);
          }
        });
      }
  
      host.querySelector<HTMLButtonElement>(".scm-commit-btn")?.addEventListener("click", () => void this.commit(host));
      host.querySelector<HTMLButtonElement>(".scm-refresh")?.addEventListener("click", () => void this.render(host));
  
      host.querySelectorAll<HTMLButtonElement>("[data-scm-action]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const action = btn.getAttribute("data-scm-action")!;
          const path = btn.getAttribute("data-scm-path")!;
          void this.handleAction(host, action, path);
        });
      });
  
      host.querySelectorAll<HTMLElement>("[data-scm-file]").forEach((row) => {
        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("[data-scm-action]")) return;
          const path = row.getAttribute("data-scm-file")!;
          const isStaged = row.getAttribute("data-scm-staged") === "1";
          this.deps.onOpenDiff(path, isStaged);
        });
      });
    }
  
    private renderSection(title: string, files: GitFile[], isStaged: boolean): string {
      const rows = files
        .map((f) => {
          const action = isStaged ? "unstage" : "stage";
          const actionLabel = isStaged ? "−" : "+";
          const actionTitle = isStaged ? "取消暂存" : "暂存";
          return `
            <div class="scm-row" data-scm-file="${escapeHtml(f.path)}" data-scm-staged="${
              isStaged ? "1" : "0"
            }">
              <span class="scm-status scm-status-${statusLabel(f)}">${escapeHtml(statusLabel(f))}</span>
              <span class="scm-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
              <button type="button" class="scm-action" data-scm-action="${action}" data-scm-path="${escapeHtml(
                f.path,
              )}" title="${actionTitle}">${actionLabel}</button>
            </div>
          `;
        })
        .join("");
      return `
        <div class="scm-section">
          <div class="scm-section-title">${escapeHtml(title)} <span class="scm-count">${files.length}</span></div>
          ${rows}
        </div>
      `;
    }
  
    private async handleAction(host: HTMLElement, action: string, path: string): Promise<void> {
      const ws = this.deps.getWorkspace();
      if (!ws) return;
      let res: GitOpResult;
      if (action === "stage") {
        res = (await window.easycode.gitStage(ws, [path])) as GitOpResult;
      } else if (action === "unstage") {
        res = (await window.easycode.gitUnstage(ws, [path])) as GitOpResult;
      } else {
        return;
      }
      if (!res.ok) this.deps.showToast("Git 操作失败：" + res.message);
      await this.render(host);
    }
  
    private async commit(host: HTMLElement): Promise<void> {
      const ws = this.deps.getWorkspace();
      if (!ws) return;
      const msg = this.commitMessage.trim();
      if (!msg) {
        this.deps.showToast("请输入提交信息");
        return;
      }
      const res = (await window.easycode.gitCommit(ws, msg)) as GitOpResult;
      if (!res.ok) {
        this.deps.showToast("提交失败：" + res.message);
        return;
      }
      this.deps.showToast("已提交");
      this.commitMessage = "";
      await this.render(host);
    }
  }