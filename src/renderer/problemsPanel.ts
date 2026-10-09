import { monaco } from "./monacoSetup";

export interface ProblemItem {
  resource: string;
  path: string;
  message: string;
  severity: monaco.MarkerSeverity;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
}

export function collectProblems(): ProblemItem[] {
  const items: ProblemItem[] = [];
  for (const model of monaco.editor.getModels()) {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    for (const m of markers) {
      items.push({
        resource: model.uri.toString(),
        path: model.uri.fsPath || model.uri.path,
        message: m.message,
        severity: m.severity,
        startLineNumber: m.startLineNumber,
        startColumn: m.startColumn,
        endLineNumber: m.endLineNumber,
        endColumn: m.endColumn,
        source: m.source,
      });
    }
  }
  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    return a.path.localeCompare(b.path) || a.startLineNumber - b.startLineNumber;
  });
  return items;
}

export function countProblems(): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const p of collectProblems()) {
    if (p.severity === monaco.MarkerSeverity.Error) errors += 1;
    else if (p.severity === monaco.MarkerSeverity.Warning) warnings += 1;
  }
  return { errors, warnings };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function severityClass(sev: monaco.MarkerSeverity): string {
  if (sev === monaco.MarkerSeverity.Error) return "err";
  if (sev === monaco.MarkerSeverity.Warning) return "warn";
  if (sev === monaco.MarkerSeverity.Info) return "info";
  return "hint";
}

function severityLabel(sev: monaco.MarkerSeverity): string {
  if (sev === monaco.MarkerSeverity.Error) return "Error";
  if (sev === monaco.MarkerSeverity.Warning) return "Warning";
  if (sev === monaco.MarkerSeverity.Info) return "Info";
  return "Hint";
}

export function renderProblemsList(
  el: HTMLElement,
  onOpen: (item: ProblemItem) => void,
): void {
  const items = collectProblems();
  if (!items.length) {
    el.innerHTML = `<div class="panel-placeholder">未检测到问题。</div>`;
    return;
  }
  el.innerHTML = `
    <div class="problems-list">
      ${items
        .map(
          (p, i) => `
        <button type="button" class="problem-row" data-idx="${i}">
          <span class="sev ${severityClass(p.severity)}">${severityLabel(p.severity)}</span>
          <span class="msg">${escapeHtml(p.message)}</span>
          <span class="loc">${escapeHtml(p.path.split(/[/\\]/).pop() || p.path)}:${p.startLineNumber}</span>
        </button>`,
        )
        .join("")}
    </div>`;
  el.querySelectorAll<HTMLButtonElement>(".problem-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-idx"));
      const item = items[idx];
      if (item) onOpen(item);
    });
  });
}
