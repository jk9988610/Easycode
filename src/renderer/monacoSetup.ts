import * as monaco from "monaco-editor";

self.MonacoEnvironment = {
  getWorker() {
    return new Worker(
      new URL(
        "monaco-editor/esm/vs/editor/editor.worker.js",
        import.meta.url,
      ),
      { type: "module" },
    );
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
      "editor.background": "#1a1f24",
      "editor.foreground": "#e6edf2",
      "editorLineNumber.foreground": "#5a6a76",
      "editorLineNumber.activeForeground": "#8b9aa6",
      "editorCursor.foreground": "#3d8fa0",
      "editor.selectionBackground": "#3d8fa055",
      "editor.inactiveSelectionBackground": "#3d8fa033",
      "editor.lineHighlightBackground": "#22282f66",
      "editor.lineHighlightBorder": "#00000000",
      "editorWidget.background": "#22282f",
      "editorWidget.border": "#3a4550",
      "editorSuggestWidget.background": "#22282f",
      "editorSuggestWidget.border": "#3a4550",
      "editorSuggestWidget.selectedBackground": "#314049",
      "editorIndentGuide.background1": "#2a323a",
      "editorIndentGuide.activeBackground1": "#3a4550",
      "scrollbarSlider.background": "#3a455066",
      "scrollbarSlider.hoverBackground": "#3a455099",
      "scrollbarSlider.activeBackground": "#3d8fa088",
      "diffEditor.insertedTextBackground": "#5a9e6f33",
      "diffEditor.removedTextBackground": "#c45c5c33",
    },
  });
}

export { monaco };
