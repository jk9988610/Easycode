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

export { monaco };
