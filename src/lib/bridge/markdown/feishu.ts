import type { InlineButton, ToolCallInfo } from '../types.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build a compact tool-progress summary.
 *
 * Successes are intentionally reduced to a count — listing every WebSearch or
 * Bash call turns a long agent turn into a wall of one-line updates. Failures
 * keep their tool name, input summary and reason so the user can see what was
 * attempted and why it was refused.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';

  const runningByName = new Map<string, number>();
  let completed = 0;
  const errors: ToolCallInfo[] = [];

  for (const tool of tools) {
    if (tool.status === 'running') {
      runningByName.set(tool.name, (runningByName.get(tool.name) ?? 0) + 1);
    } else if (tool.status === 'complete') {
      completed++;
    } else {
      errors.push(tool);
    }
  }

  const lines: string[] = [];

  if (runningByName.size > 0) {
    const running = [...runningByName.entries()].slice(0, 3)
      .map(([name, count]) => `${name} ×${count}`)
      .join(' · ');
    const more = runningByName.size > 3 ? ` · …另有 ${runningByName.size - 3} 类` : '';
    lines.push(`🔄 进行中：${running}${more}`);
  }

  if (completed > 0) {
    lines.push(`✅ 已完成 ${completed} 次工具调用`);
  }

  if (errors.length > 3) {
    lines.push(`…另有 ${errors.length - 3} 条失败未展开`);
  }

  for (const tool of errors.slice(-3)) {
    const input = tool.inputSummary
      ? ` \`${tool.inputSummary.replace(/`/g, "'")}\``
      : '';
    const reason = tool.errorKind === 'denied'
      ? '用户拒绝'
      : tool.errorKind === 'timeout'
        ? '权限超时'
        : tool.errorKind === 'policy'
          ? '策略拒绝'
          : `工具错误${tool.errorMessage ? `：${tool.errorMessage.replace(/`/g, "'")}` : ''}`;
    lines.push(`❌ ${tool.name}${input} — ${reason}`);
  }

  return lines.join('\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the body elements array for a streaming card update.
 * Combines main text content with tool progress.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = text || '';
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '💭 Thinking...';
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main text content
  const content = preprocessFeishuMarkdown(text);
  const toolMd = buildToolProgressMarkdown(tools);

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Tool summary is visually separate from the answer, and failure details are
  // kept here instead of being mixed into the response body.
  if (toolMd) {
    elements.push({
      tag: 'markdown',
      content: toolMd,
      text_align: 'left',
      text_size: 'notation',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  type PermButton = { label: string; type: string; action: string };

  const allowButtons: PermButton[] = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  // Deny only fails that one tool call — the agent keeps working on the turn.
  // The aborting variant gets its own row so it isn't a mis-tap.
  const stopButtons: PermButton[] = [
    { label: 'Deny & Stop', type: 'danger', action: 'deny_stop' },
  ];

  const rows: InlineButton[][] = [
    allowButtons.map((btn) => ({
      text: btn.label,
      callbackData: `perm:${btn.action}:${permissionRequestId}`,
    })),
    stopButtons.map((btn) => ({
      text: btn.label,
      callbackData: `perm:${btn.action}:${permissionRequestId}`,
    })),
  ];

  return buildPermissionActionCard(text, rows, chatId, {
    title: 'Permission Required',
    template: 'blue',
    iconToken: 'lock-chat_filled',
    expiryNote: '⏱ This request will expire in 5 minutes',
    commandHint: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny · `4` Deny & Stop',
  });
}

/**
 * Options for a Feishu permission card.
 *
 * `update_multi: true` is required by Feishu's `im.message.patch` API: only
 * shared cards that opt in can be edited after they are sent. Batch cards are
 * edited in place as more permission requests arrive.
 */
export interface PermissionCardOptions {
  title?: string;
  template?: string;
  iconToken?: string;
  expiryNote?: string;
  commandHint?: string;
  /** Render the card without the button rows (e.g. after a batch is resolved). */
  showButtons?: boolean;
}

/**
 * Build a permission card from an arbitrary button layout.
 *
 * The broker owns the action semantics; this function only renders the
 * buttons' labels and callback data. Batch cards pass
 * `perm:batch:<batchId>:<action>` callbacks here.
 */
export function buildPermissionActionCard(
  text: string,
  inlineButtons: InlineButton[][],
  chatId?: string,
  options: PermissionCardOptions = {},
): string {
  const buttonType = (callbackData: string): string => {
    const parts = callbackData.split(':');
    const action = parts[0] === 'perm' && parts[1] === 'batch'
      ? parts[parts.length - 1]
      : parts[1];
    if (action === 'deny' || action === 'deny_stop') return 'danger';
    if (action === 'allow') return 'primary';
    return 'default';
  };

  const toColumns = (buttons: InlineButton[]) => buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.text },
      type: buttonType(btn.callbackData),
      size: 'medium',
      value: { callback_data: btn.callbackData, ...(chatId ? { chatId } : {}) },
    }],
  }));

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: text, text_size: 'normal' },
  ];

  if (options.expiryNote) {
    elements.push({ tag: 'markdown', content: options.expiryNote, text_size: 'notation' });
  }

  if (options.showButtons !== false && inlineButtons.length > 0) {
    elements.push({ tag: 'hr' });
    for (const row of inlineButtons) {
      if (row.length === 0) continue;
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_align: 'left',
        columns: toColumns(row),
      });
    }
  }

  if (options.commandHint) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: options.commandHint, text_size: 'notation' });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: options.title || 'Permission Required' },
      template: options.template || 'blue',
      ...(options.iconToken
        ? { icon: { tag: 'standard_icon', token: options.iconToken } }
        : {}),
      padding: '12px 12px 12px 12px',
    },
    body: { elements },
  });
}
