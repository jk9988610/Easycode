import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export interface LanguageServerSpec {
  id: string;
  command: string;
  args?: string[];
  languages?: string[];
  /** Relative workspace files that improve language support (e.g. compile_commands.json). */
  workspaceFiles?: string[];
  missingWorkspaceFileMethod?: string;
}

export interface LanguageServerOptions {
  spec: LanguageServerSpec;
  workspaceRoot: string;
  onNotification: (method: string, params: unknown) => void;
  onExit: () => void;
}

/**
 * Generic LSP JSON-RPC over stdio (Content-Length framing).
 * Editor core starts servers described by extensions — not a specific tool like clangd.
 */
export class LanguageServerSession {
  ready = false;
  workspaceRoot: string;
  readonly spec: LanguageServerSpec;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private opts: LanguageServerOptions;
  private stopping = false;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(opts: LanguageServerOptions) {
    this.opts = opts;
    this.spec = opts.spec;
    this.workspaceRoot = opts.workspaceRoot;
  }

  async start(): Promise<void> {
    const args = [...(this.spec.args || [])];
    this.proc = spawn(this.spec.command, args, {
      cwd: this.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    this.proc.on("exit", () => {
      this.ready = false;
      for (const [, p] of this.pending) {
        p.reject(new Error(`${this.spec.id} exited`));
      }
      this.pending.clear();
      if (!this.stopping) this.opts.onExit();
    });

    this.proc.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf-8");
      if (text.trim()) console.log(`[${this.spec.id}]`, text.trim());
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

    const rootUri = pathToFileURL(
      this.workspaceRoot.endsWith(path.sep)
        ? this.workspaceRoot
        : this.workspaceRoot + path.sep,
    ).href;

    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.workspaceRoot,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["plaintext", "markdown"],
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [
        { uri: rootUri, name: path.basename(this.workspaceRoot) },
      ],
      initializationOptions: {},
    });

    this.notify("initialized", {});
    this.ready = true;

    for (const rel of this.spec.workspaceFiles || []) {
      const full = path.join(this.workspaceRoot, rel);
      if (!fs.existsSync(full)) {
        const method =
          this.spec.missingWorkspaceFileMethod ||
          "easycode/missingWorkspaceFile";
        this.opts.onNotification(method, {
          workspace: this.workspaceRoot,
          file: rel,
          serverId: this.spec.id,
        });
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + len;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        this.handleMessage(JSON.parse(body));
      } catch (err) {
        console.error("bad lsp message", err);
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || "LSP error"));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.opts.onNotification(msg.method, msg.params);
    }
  }

  private write(payload: object): void {
    if (!this.proc?.stdin) throw new Error(`${this.spec.id} stdin closed`);
    const json = JSON.stringify(payload);
    const msg = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
    this.proc.stdin.write(msg, "utf-8");
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      /* ignore */
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
  }
}
