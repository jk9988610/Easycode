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
      "editor.background": "#000000",
      "editor.foreground": "#e6e6e6",
      "editorLineNumber.foreground": "#4a4a4a",
      "editorLineNumber.activeForeground": "#888888",
      "editorCursor.foreground": "#60a5fa",
      "editor.selectionBackground": "#3b82f655",
      "editor.inactiveSelectionBackground": "#3b82f633",
      "editor.lineHighlightBackground": "#0a0a0a",
      "editor.lineHighlightBorder": "#00000000",
      "editorWidget.background": "#0a0a0a",
      "editorWidget.border": "#1c1c1c",
      "editorSuggestWidget.background": "#0a0a0a",
      "editorSuggestWidget.border": "#1c1c1c",
      "editorSuggestWidget.selectedBackground": "#1a1a1a",
      "editorIndentGuide.background1": "#1c1c1c",
      "editorIndentGuide.activeBackground1": "#303030",
      "scrollbarSlider.background": "#26262666",
      "scrollbarSlider.hoverBackground": "#3a3a3a99",
      "scrollbarSlider.activeBackground": "#3b82f688",
      "diffEditor.insertedTextBackground": "#3fb95033",
      "diffEditor.removedTextBackground": "#f8514933",
      "editorGutter.background": "#000000",
      "editorOverviewRuler.border": "#00000000",
      "minimap.background": "#000000",
    },
  });
}

export { monaco };
