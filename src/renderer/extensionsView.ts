import type { PluginInfo } from "./types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export function extensionsPanelHtml(plugins: PluginInfo[], error?: string): string {
  const err = error
    ? `<p class="placeholder-hint ext-error">${escapeHtml(error)}</p>`
    : "";
  const list =
    plugins.length === 0
      ? `<div class="empty-hint">尚未安装扩展。<br/>可从本地安装 .vsix 或扩展文件夹。</div>`
      : plugins
          .map((p) => {
            const meta = [p.publisher, p.version ? `v${p.version}` : ""]
              .filter(Boolean)
              .join(" · ");
            return `<div class="ext-item" data-id="${escapeAttr(p.id)}">
              <div class="ext-item-main">
                <div class="ext-item-name">${escapeHtml(p.name)}</div>
                <div class="ext-item-id">${escapeHtml(p.id)}</div>
                ${meta ? `<div class="ext-item-meta">${escapeHtml(meta)}</div>` : ""}
                ${
                  p.description
                    ? `<div class="ext-item-desc">${escapeHtml(p.description)}</div>`
                    : ""
                }
              </div>
              <div class="ext-item-actions">
                <label class="ext-toggle">
                  <input type="checkbox" data-ext-toggle ${p.enabled ? "checked" : ""} />
                  <span>${p.enabled ? "已启用" : "已禁用"}</span>
                </label>
                <button type="button" data-ext-uninstall>卸载</button>
              </div>
            </div>`;
          })
          .join("");

  return `<div class="ext-panel">
    <div class="ext-toolbar">
      <button type="button" class="primary" data-ext-install-vsix>从 VSIX 安装…</button>
      <button type="button" data-ext-install-folder>从文件夹安装…</button>
    </div>
    <p class="placeholder-hint">使用 VS Code / Open VSX 通用的 .vsix 格式，仅本地安装，不连接市场。</p>
    ${err}
    <div class="ext-list">${list}</div>
  </div>`;
}
