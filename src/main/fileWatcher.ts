import fs from "node:fs";
import path from "node:path";

function norm(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

export type FsWatchEvent =
  | { type: "change"; path: string }
  | { type: "unlink"; path: string }
  | { type: "tree"; path: string; root: string };

/**
 * Watch open files + workspace tree for external FS changes.
 * Own writes should call ignore() so we don't bounce-reload ourselves.
 */
export class FileWatcher {
  /** Open-file watches keyed by parent dir. */
  private fileDirWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; files: Map<string, string> }
  >();
  private workspaceWatcher: fs.FSWatcher | null = null;
  private workspaceRoot: string | null = null;
  private ignoreUntil = new Map<string, number>();
  private fileDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private treeDebounce: ReturnType<typeof setTimeout> | null = null;
  private onEvent: (event: FsWatchEvent) => void;

  constructor(onEvent: (event: FsWatchEvent) => void) {
    this.onEvent = onEvent;
  }

  watchFile(filePath: string): void {
    const abs = path.resolve(filePath);
    const dir = path.dirname(abs);
    const dirKey = norm(dir);
    const base = path.basename(abs).toLowerCase();

    let entry = this.fileDirWatchers.get(dirKey);
    if (!entry) {
      try {
        const watcher = fs.watch(dir, { persistent: true }, (_event, filename) => {
          const current = this.fileDirWatchers.get(dirKey);
          if (!current) return;
          if (!filename) {
            for (const full of current.files.values()) {
              this.scheduleFile(full);
            }
            return;
          }
          const name = filename.toString().toLowerCase();
          const full = current.files.get(name);
          if (full) this.scheduleFile(full);
        });
        watcher.on("error", () => {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
          this.fileDirWatchers.delete(dirKey);
        });
        entry = { watcher, files: new Map() };
        this.fileDirWatchers.set(dirKey, entry);
      } catch (err) {
        console.warn("[file-watch] file watch failed", dir, err);
        return;
      }
    }
    entry.files.set(base, abs);
  }

  unwatchFile(filePath: string): void {
    const abs = path.resolve(filePath);
    const dir = path.dirname(abs);
    const dirKey = norm(dir);
    const base = path.basename(abs).toLowerCase();
    const entry = this.fileDirWatchers.get(dirKey);
    if (!entry) return;
    entry.files.delete(base);
    this.ignoreUntil.delete(norm(abs));
    const t = this.fileDebounce.get(norm(abs));
    if (t) {
      clearTimeout(t);
      this.fileDebounce.delete(norm(abs));
    }
    if (entry.files.size === 0) {
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
      this.fileDirWatchers.delete(dirKey);
    }
  }

  watchWorkspace(root: string): void {
    const abs = path.resolve(root);
    if (this.workspaceRoot && norm(this.workspaceRoot) === norm(abs)) return;
    this.unwatchWorkspace();
    this.workspaceRoot = abs;
    try {
      this.workspaceWatcher = fs.watch(
        abs,
        { persistent: true, recursive: true },
        (_event, filename) => {
          if (!this.workspaceRoot) return;
          const changed = filename
            ? path.join(this.workspaceRoot, filename.toString())
            : this.workspaceRoot;
          this.scheduleTree(changed);
        },
      );
      this.workspaceWatcher.on("error", () => {
        this.unwatchWorkspace();
      });
    } catch (err) {
      console.warn("[file-watch] workspace watch failed", abs, err);
      // Fallback: non-recursive watch of root only
      try {
        this.workspaceWatcher = fs.watch(abs, { persistent: true }, () => {
          if (this.workspaceRoot) this.scheduleTree(this.workspaceRoot);
        });
      } catch (err2) {
        console.warn("[file-watch] workspace fallback failed", abs, err2);
        this.workspaceRoot = null;
      }
    }
  }

  unwatchWorkspace(): void {
    if (this.workspaceWatcher) {
      try {
        this.workspaceWatcher.close();
      } catch {
        /* ignore */
      }
      this.workspaceWatcher = null;
    }
    this.workspaceRoot = null;
    if (this.treeDebounce) {
      clearTimeout(this.treeDebounce);
      this.treeDebounce = null;
    }
  }

  /** Suppress change events briefly after Easycode writes the file. */
  ignore(filePath: string, ms = 1200): void {
    this.ignoreUntil.set(norm(filePath), Date.now() + ms);
  }

  dispose(): void {
    this.unwatchWorkspace();
    for (const entry of this.fileDirWatchers.values()) {
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.fileDirWatchers.clear();
    for (const t of this.fileDebounce.values()) clearTimeout(t);
    this.fileDebounce.clear();
    this.ignoreUntil.clear();
  }

  private scheduleFile(filePath: string): void {
    const key = norm(filePath);
    const until = this.ignoreUntil.get(key) || 0;
    if (Date.now() < until) return;

    const prev = this.fileDebounce.get(key);
    if (prev) clearTimeout(prev);
    this.fileDebounce.set(
      key,
      setTimeout(() => {
        this.fileDebounce.delete(key);
        const stillUntil = this.ignoreUntil.get(key) || 0;
        if (Date.now() < stillUntil) return;
        let exists = false;
        try {
          exists = fs.existsSync(filePath);
        } catch {
          exists = false;
        }
        if (exists) this.onEvent({ type: "change", path: filePath });
        else this.onEvent({ type: "unlink", path: filePath });
      }, 200),
    );
  }

  private scheduleTree(changedPath: string): void {
    const key = norm(changedPath);
    const until = this.ignoreUntil.get(key) || 0;
    if (Date.now() < until) return;
    if (!this.workspaceRoot) return;

    if (this.treeDebounce) clearTimeout(this.treeDebounce);
    this.treeDebounce = setTimeout(() => {
      this.treeDebounce = null;
      if (!this.workspaceRoot) return;
      this.onEvent({
        type: "tree",
        path: changedPath,
        root: this.workspaceRoot,
      });
    }, 250);
  }
}
