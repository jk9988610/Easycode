import { monaco, pathToUri } from "./monacoSetup";

type DiagnosticParams = {
  uri: string;
  diagnostics: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    message: string;
    severity?: number;
    source?: string;
  }>;
};

function severityToMarker(sev?: number): monaco.MarkerSeverity {
  switch (sev) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

export class LspBridge {
  private disposables: monaco.IDisposable[] = [];
  private openDocs = new Set<string>();
  private version = new Map<string, number>();
  private running = false;

  constructor(
    private request: (method: string, params: unknown) => Promise<unknown>,
    private notify: (method: string, params: unknown) => Promise<void>,
  ) {}

  setRunning(running: boolean): void {
    this.running = running;
    if (!running) {
      monaco.editor.getModels().forEach((m) => {
        monaco.editor.setModelMarkers(m, "clangd", []);
      });
    }
  }

  handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as DiagnosticParams;
      const model = monaco.editor
        .getModels()
        .find((m) => m.uri.toString() === p.uri || pathToUri(m.uri.fsPath) === p.uri);
      // Match by normalizing
      const models = monaco.editor.getModels();
      const target =
        models.find((m) => m.uri.toString() === p.uri) ||
        models.find((m) => pathToUri(m.uri.fsPath).toLowerCase() === p.uri.toLowerCase());
      if (!target) return;
      const markers = (p.diagnostics || []).map((d) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        message: d.message,
        severity: severityToMarker(d.severity),
        source: d.source || "clangd",
      }));
      monaco.editor.setModelMarkers(target, "clangd", markers);
    }
  }

  async didOpen(filePath: string, languageId: string, text: string): Promise<void> {
    if (!this.running) return;
    const uri = pathToUri(filePath);
    this.openDocs.add(uri);
    this.version.set(uri, 1);
    await this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageId === "c" || languageId === "cpp" ? languageId : "c",
        version: 1,
        text,
      },
    });
  }

  async didChange(filePath: string, text: string): Promise<void> {
    if (!this.running) return;
    const uri = pathToUri(filePath);
    if (!this.openDocs.has(uri)) return;
    const ver = (this.version.get(uri) || 1) + 1;
    this.version.set(uri, ver);
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version: ver },
      contentChanges: [{ text }],
    });
  }

  async didSave(filePath: string, text: string): Promise<void> {
    if (!this.running) return;
    const uri = pathToUri(filePath);
    await this.notify("textDocument/didSave", {
      textDocument: { uri },
      text,
    });
  }

  async didClose(filePath: string): Promise<void> {
    if (!this.running) return;
    const uri = pathToUri(filePath);
    this.openDocs.delete(uri);
    this.version.delete(uri);
    await this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  registerProviders(): void {
    this.dispose();

    this.disposables.push(
      monaco.languages.registerCompletionItemProvider(["c", "cpp"], {
        triggerCharacters: [".", ">", ":", "#", "<", '"', "/"],
        provideCompletionItems: async (model, position) => {
          if (!this.running) return { suggestions: [] };
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = (await this.request("textDocument/completion", {
              textDocument: { uri },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            })) as
              | { items?: CompletionItem[] }
              | CompletionItem[]
              | null;
            const items = Array.isArray(result)
              ? result
              : result?.items || [];
            return {
              suggestions: items.map((item, i) => {
                const word = model.getWordUntilPosition(position);
                const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
                };
                return {
                  label: item.label,
                  kind: mapCompletionKind(item.kind),
                  insertText: item.insertText || item.label,
                  detail: item.detail,
                  documentation:
                    typeof item.documentation === "string"
                      ? item.documentation
                      : item.documentation?.value,
                  range,
                  sortText: item.sortText || String(i).padStart(5, "0"),
                };
              }),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      }),
    );

    this.disposables.push(
      monaco.languages.registerHoverProvider(["c", "cpp"], {
        provideHover: async (model, position) => {
          if (!this.running) return null;
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = (await this.request("textDocument/hover", {
              textDocument: { uri },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            })) as {
              contents?:
                | string
                | { value: string }
                | Array<string | { value: string }>;
              range?: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            } | null;
            if (!result?.contents) return null;
            const contents = normalizeMarkup(result.contents);
            return {
              contents: contents.map((v) => ({ value: v })),
              range: result.range
                ? {
                    startLineNumber: result.range.start.line + 1,
                    startColumn: result.range.start.character + 1,
                    endLineNumber: result.range.end.line + 1,
                    endColumn: result.range.end.character + 1,
                  }
                : undefined,
            };
          } catch {
            return null;
          }
        },
      }),
    );

    this.disposables.push(
      monaco.languages.registerDefinitionProvider(["c", "cpp"], {
        provideDefinition: async (model, position) => {
          if (!this.running) return null;
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = await this.request("textDocument/definition", {
              textDocument: { uri },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            });
            return toLocationLinks(result);
          } catch {
            return null;
          }
        },
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  sortText?: string;
}

function mapCompletionKind(kind?: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  };
  return map[kind || 1] || K.Text;
}

function normalizeMarkup(
  contents: string | { value: string } | Array<string | { value: string }>,
): string[] {
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === "string" ? c : c.value));
  }
  return [contents.value];
}

function toLocationLinks(result: unknown): monaco.languages.LocationLink[] | null {
  if (!result) return null;
  const arr = Array.isArray(result) ? result : [result];
  return arr
    .map((loc: {
      uri?: string;
      targetUri?: string;
      range?: { start: { line: number; character: number }; end: { line: number; character: number } };
      targetRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
      targetSelectionRange?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }) => {
      const uri = loc.targetUri || loc.uri;
      const range = loc.targetSelectionRange || loc.targetRange || loc.range;
      if (!uri || !range) return null;
      return {
        uri: monaco.Uri.parse(uri),
        range: {
          startLineNumber: range.start.line + 1,
          startColumn: range.start.character + 1,
          endLineNumber: range.end.line + 1,
          endColumn: range.end.character + 1,
        },
      };
    })
    .filter(Boolean) as monaco.languages.LocationLink[];
}
