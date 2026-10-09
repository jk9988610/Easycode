import { monaco, pathToUri } from "./monacoSetup";

/** LSP 支持的语言列表(用于注册 Monaco providers) */
const LSP_LANGUAGES = [
  "c",
  "cpp",
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "python",
];

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
        monaco.editor.setModelMarkers(m, "lsp", []);
      });
    }
  }

  handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as DiagnosticParams;
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
        source: d.source || "lsp",
      }));
      monaco.editor.setModelMarkers(target, "lsp", markers);
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
        languageId,
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

    // --- Completion (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerCompletionItemProvider(LSP_LANGUAGES, {
        triggerCharacters: [".", ">", ":", "#", "<", '"', "/", "(", "'", "@"],
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

    // --- Hover (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerHoverProvider(LSP_LANGUAGES, {
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

    // --- Definition (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerDefinitionProvider(LSP_LANGUAGES, {
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

    // --- References (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerReferenceProvider(LSP_LANGUAGES, {
        provideReferences: async (model, position, _context) => {
          if (!this.running) return [];
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = await this.request("textDocument/references", {
              textDocument: { uri },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
              context: { includeDeclaration: true },
            });
            return toLocations(result);
          } catch {
            return [];
          }
        },
      }),
    );

    // --- Document Symbols / Outline (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerDocumentSymbolProvider(LSP_LANGUAGES, {
        provideDocumentSymbols: async (model) => {
          if (!this.running) return [];
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = (await this.request("textDocument/documentSymbol", {
              textDocument: { uri },
            })) as DocumentSymbol[] | null;
            if (!result) return [];
            return result.map((s) => toDocumentSymbol(s));
          } catch {
            return [];
          }
        },
      }),
    );

    // --- Signature Help (所有 LSP 语言) ---
    this.disposables.push(
      monaco.languages.registerSignatureHelpProvider(LSP_LANGUAGES, {
        signatureHelpTriggerCharacters: ["(", ","],
        provideSignatureHelp: async (model, position): Promise<monaco.languages.SignatureHelpResult | null> => {
          if (!this.running) return null;
          try {
            const uri = pathToUri(model.uri.fsPath);
            const result = (await this.request("textDocument/signatureHelp", {
              textDocument: { uri },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            })) as {
              signatures: Array<{
                label: string;
                documentation?: string | { value: string };
                parameters?: Array<{ label: string | [number, number]; documentation?: string | { value: string } }>;
              }>;
              activeSignature?: number;
              activeParameter?: number;
            } | null;
            if (!result?.signatures) return null;
            return {
              value: {
                activeSignature: result.activeSignature ?? 0,
                activeParameter: result.activeParameter ?? 0,
                signatures: result.signatures.map((s) => ({
                  label: s.label,
                  documentation:
                    typeof s.documentation === "string"
                      ? s.documentation
                      : s.documentation?.value,
                  parameters: (s.parameters || []).map((p) => ({
                    label: typeof p.label === "string" ? p.label : "",
                    documentation:
                      typeof p.documentation === "string"
                        ? p.documentation
                        : p.documentation?.value,
                  })),
                })),
              },
              dispose: () => {},
            };
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

// ---------------------------------------------------------------------------
// 类型定义 & 转换工具
// ---------------------------------------------------------------------------

interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  sortText?: string;
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: DocumentSymbol[];
  detail?: string;
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
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
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

function toLocations(result: unknown): monaco.languages.Location[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr
    .map((loc: {
      uri?: string;
      range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    }) => {
      if (!loc.uri || !loc.range) return null;
      return {
        uri: monaco.Uri.parse(loc.uri),
        range: {
          startLineNumber: loc.range.start.line + 1,
          startColumn: loc.range.start.character + 1,
          endLineNumber: loc.range.end.line + 1,
          endColumn: loc.range.end.character + 1,
        },
      };
    })
    .filter(Boolean) as monaco.languages.Location[];
}

function toDocumentSymbol(s: DocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail || "",
    kind: mapSymbolKind(s.kind),
    tags: [],
    range: {
      startLineNumber: s.range.start.line + 1,
      startColumn: s.range.start.character + 1,
      endLineNumber: s.range.end.line + 1,
      endColumn: s.range.end.character + 1,
    },
    selectionRange: {
      startLineNumber: s.selectionRange.start.line + 1,
      startColumn: s.selectionRange.start.character + 1,
      endLineNumber: s.selectionRange.end.line + 1,
      endColumn: s.selectionRange.end.character + 1,
    },
    children: (s.children || []).map((c) => toDocumentSymbol(c)),
  };
}

function mapSymbolKind(kind: number): monaco.languages.SymbolKind {
  const K = monaco.languages.SymbolKind;
  const map: Record<number, monaco.languages.SymbolKind> = {
    1: K.File,
    2: K.Module,
    3: K.Namespace,
    4: K.Package,
    5: K.Class,
    6: K.Method,
    7: K.Property,
    8: K.Field,
    9: K.Constructor,
    10: K.Enum,
    11: K.Interface,
    12: K.Function,
    13: K.Variable,
    14: K.Constant,
    15: K.String,
    16: K.Number,
    17: K.Boolean,
    18: K.Array,
    19: K.Object,
    20: K.Key,
    21: K.Null,
    22: K.EnumMember,
    23: K.Struct,
    24: K.Event,
    25: K.Operator,
    26: K.TypeParameter,
  };
  return map[kind] || K.Variable;
}
