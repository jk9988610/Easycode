import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ShellKind } from "./types";

export interface TermTab {
  id: string;
  kind: ShellKind;
  title: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
}

/**
 * Bottom panel terminal manager (xterm.js + main-process shells).
 */
export class TerminalPanel {
  private host: HTMLElement;
  private tabs: TermTab[] = [];
  private activeId: string | null = null;
  private unsubData: (() => void) | null = null;
  private unsubExit: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.unsubData = window.easycode.onTermData(({ id, data }) => {
      const t = this.tabs.find((x) => x.id === id);
      t?.term.write(data);
    });
    this.unsubExit = window.easycode.onTermExit(({ id, code }) => {
      const t = this.tabs.find((x) => x.id === id);
      if (t) {
        t.term.writeln(`\r\n\x1b[90m[进程已退出 code=${code ?? "?"}]\x1b[0m`);
      }
    });
  }

  dispose(): void {
    this.unsubData?.();
    this.unsubExit?.();
    for (const t of this.tabs) {
      void window.easycode.termKill(t.id);
      t.term.dispose();
    }
    this.tabs = [];
  }

  async open(kind: ShellKind): Promise<void> {
    const info = await window.easycode.termCreate(kind);
    this.mountSession(info);
  }

  /** Attach UI for a terminal already created in the main process (extension host). */
  attachExisting(info: { id: string; kind: ShellKind; title: string }): void {
    if (this.tabs.some((t) => t.id === info.id)) {
      this.activate(info.id);
      return;
    }
    this.mountSession(info);
  }

  removeUiOnly(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [t] = this.tabs.splice(idx, 1);
    t.term.dispose();
    t.el.remove();
    if (this.activeId === id) {
      this.activeId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
      if (this.activeId) this.activate(this.activeId);
    }
  }

  private mountSession(info: { id: string; kind: ShellKind; title: string }): void {
    const el = document.createElement("div");
    el.className = "term-view";
    el.style.display = "none";
    this.host.appendChild(el);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      theme: {
        background: "#000000",
        foreground: "#e6e6e6",
        cursor: "#60a5fa",
        cursorAccent: "#000000",
        selectionBackground: "rgba(96, 165, 250, 0.25)",
        black: "#1c1c1c",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#e6e6e6",
        brightBlack: "#6e7681",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff",
      },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.onData((data) => {
      void window.easycode.termWrite(info.id, data);
    });

    const tab: TermTab = {
      id: info.id,
      kind: info.kind,
      title: info.title,
      term,
      fit,
      el,
    };
    this.tabs.push(tab);
    this.activate(info.id);
    requestAnimationFrame(() => {
      try {
        fit.fit();
        void window.easycode.termResize(info.id, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
  }

  activate(id: string): void {
    this.activeId = id;
    for (const t of this.tabs) {
      t.el.style.display = t.id === id ? "block" : "none";
    }
    const cur = this.tabs.find((t) => t.id === id);
    if (cur) {
      requestAnimationFrame(() => {
        try {
          cur.fit.fit();
          cur.term.focus();
          void window.easycode.termResize(cur.id, cur.term.cols, cur.term.rows);
        } catch {
          /* ignore */
        }
      });
    }
  }

  async close(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [t] = this.tabs.splice(idx, 1);
    await window.easycode.termKill(t.id);
    t.term.dispose();
    t.el.remove();
    if (this.activeId === id) {
      this.activeId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
      if (this.activeId) this.activate(this.activeId);
    }
  }

  layout(): void {
    const cur = this.tabs.find((t) => t.id === this.activeId);
    if (!cur) return;
    try {
      cur.fit.fit();
      void window.easycode.termResize(cur.id, cur.term.cols, cur.term.rows);
    } catch {
      /* ignore */
    }
  }

  getTabs(): { id: string; title: string; active: boolean }[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      active: t.id === this.activeId,
    }));
  }

  hasTabs(): boolean {
    return this.tabs.length > 0;
  }
}
