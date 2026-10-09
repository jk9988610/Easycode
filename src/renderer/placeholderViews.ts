/** Placeholder sidebar / panel HTML for deferred VS Code features. */

export function searchPlaceholderHtml(): string {
  return `
    <div class="placeholder-pane">
      <div class="placeholder-title">搜索</div>
      <input type="text" class="placeholder-input" placeholder="搜索（即将推出）" disabled />
      <p class="placeholder-hint">全局文件搜索尚未接入，此为布局占位。</p>
    </div>`;
}

export function scmPlaceholderHtml(): string {
  return `
    <div class="placeholder-pane">
      <div class="placeholder-title">源代码管理</div>
      <p class="placeholder-hint">Git 集成即将推出。打开文件夹后可在此管理更改。</p>
    </div>`;
}

export function accountPlaceholderHtml(): string {
  return `
    <div class="placeholder-pane">
      <div class="placeholder-title">帐户</div>
      <button type="button" class="primary" disabled>登录（占位）</button>
      <p class="placeholder-hint">登录与同步将在后续版本提供。</p>
    </div>`;
}

export function tasksPlaceholderHtml(): string {
  return `
    <div class="placeholder-pane">
      <div class="placeholder-title">任务</div>
      <p class="placeholder-hint">运行任务、配置 tasks.json 即将推出。</p>
    </div>`;
}

export function outlinePlaceholderHtml(): string {
  return `
    <div class="placeholder-pane compact">
      <p class="placeholder-hint">大纲即将推出（文档符号）。</p>
    </div>`;
}

export function chatPlaceholderHtml(opts?: { withInput?: boolean }): string {
  const input = opts?.withInput
    ? `<div class="chat-composer">
        <textarea rows="3" placeholder="描述要构建的内容（占位）" disabled></textarea>
        <div class="chat-composer-bar">
          <button type="button" disabled>发送</button>
        </div>
      </div>`
    : "";
  return `
    <div class="placeholder-pane chat-pane">
      <div class="chat-empty">开始新的对话</div>
      <div class="chat-bubble muted">AI 聊天即将接入。当前为布局占位。</div>
      ${input}
    </div>`;
}

export function outputPlaceholderHtml(): string {
  return `<div class="panel-placeholder">尚无输出。构建与任务日志将显示在此处。</div>`;
}

export function debugPlaceholderHtml(): string {
  return `<div class="panel-placeholder">调试控制台即将推出。</div>`;
}

export function loginPopoverHtml(): string {
  return `
    <div class="account-pop">
      <div class="account-pop-title">帐户</div>
      <button type="button" disabled>登录（占位）</button>
      <p>登录与设置同步稍后提供。</p>
    </div>`;
}
