import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

export function languageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".hpp"))
    return "cpp";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  return "plaintext";
}

export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) {
    return "file:///" + normalized;
  }
  return "file://" + normalized;
}

/** Align Monaco chrome with Easycode shell tokens. */
export function registerEasycodeTheme(): void {
  monaco.editor.defineTheme("easycode-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7c88", fontStyle: "italic" },
      { token: "keyword", foreground: "5eb3c4" },
      { token: "string", foreground: "8fbf7a" },
      { token: "number", foreground: "d4a35c" },
    ],
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#e6edf2",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#7d8590",
      "editorCursor.foreground": "#58a6ff",
      "editor.selectionBackground": "#58a6ff55",
      "editor.inactiveSelectionBackground": "#58a6ff33",
      "editor.lineHighlightBackground": "#161b2266",
      "editor.lineHighlightBorder": "#00000000",
      "editorWidget.background": "#161b22",
      "editorWidget.border": "#30363d",
      "editorSuggestWidget.background": "#161b22",
      "editorSuggestWidget.border": "#30363d",
      "editorSuggestWidget.selectedBackground": "#1f6feb",
      "editorIndentGuide.background1": "#1f2429",
      "editorIndentGuide.activeBackground1": "#30363d",
      "scrollbarSlider.background": "#30363d66",
      "scrollbarSlider.hoverBackground": "#30363d99",
      "scrollbarSlider.activeBackground": "#58a6ff88",
      "diffEditor.insertedTextBackground": "#3fb95033",
      "diffEditor.removedTextBackground": "#f8514933",
    },
  });
}

export { monaco };
