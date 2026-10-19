/**
 * Permission Broker — forwards Claude permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When Claude needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 *
 * Feishu additionally gets *batch cards* (plan A in docs/guardrails-design.md
 * §5): the first pending request in a chat is sent as a full individual card;
 * later requests in the same unresolved batch share one “还有 N 条” card that is
 * edited in place. Its buttons carry a batch id and resolve the whole batch:
 *
 *     perm:batch:<batchId>:allow | allow_session | deny | deny_stop
 *
 * Other channels keep the previous one-message-per-request behavior.
 */

import crypto from 'node:crypto';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { PermissionLinkRecord } from './host.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';

/**
 * The complete permission action set. `bridge-manager` (card callbacks, `/perm`,
 * numeric shortcuts) and this broker must agree on it; keep this as the single
 * source of truth instead of duplicating string arrays in both files.
 */
export const PERMISSION_ACTIONS = ['allow', 'allow_session', 'deny', 'deny_stop'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Numeric shortcut → action, shared by the router and the inline handler. */
export const PERMISSION_SHORTCUTS: Record<string, PermissionAction> = {
  '1': 'allow',
  '2': 'allow_session',
  '3': 'deny',
  '4': 'deny_stop',
};

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

export function permissionActionForShortcut(text: string): PermissionAction | undefined {
  return Object.prototype.hasOwnProperty.call(PERMISSION_SHORTCUTS, text)
    ? PERMISSION_SHORTCUTS[text]
    : undefined;
}

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

/**
 * What the model receives as the tool result when the user declines.
 *
 * A bare "denied" is ambiguous — it reads as "this tool is unavailable"
 * rather than "this action is off-limits", so the model just reaches the same
 * target another way (denying a Read of a file makes it run `cat` on it).
 * The denial also lands in the session history, so that misreading sticks for
 * the rest of the session and the card is never shown again.
 *
 * So state what was refused, forbid the workaround, and leave a legitimate
 * way out: say why, rather than silently routing around the refusal.
 */
const DENY_MESSAGE =
  'The user declined this action from their chat client. Do not try to ' +
  'achieve the same result with a different tool or command — treat the ' +
  'target as off-limits. Continue with the rest of the task; if this ' +
  'action is essential, say why instead of working around the refusal.';

/** Channels that render a dedicated, editable batch card. */
const BATCH_CARD_CHANNELS = new Set(['feishu']);

/** At most one batch-card edit per this interval (Feishu patch is 5 QPS). */
const BATCH_CARD_UPDATE_INTERVAL_MS = 800;

/** Keep the batch card short even when a subagent burst is much larger. */
const BATCH_CARD_LIST_LIMIT = 10;

/**
 * One unresolved permission batch per chat.
 *
 * The batch id is written onto every permission link so a callback from an old
 * batch card cannot resolve requests from a newer batch. `firstPermissionRequestId`
 * is the request rendered by the full card; “还有 N 条” counts the rest.
 */
interface PermissionBatchState {
  batchId: string;
  chatId: string;
  channelType: string;
  firstPermissionRequestId: string;
  adapter: BaseChannelAdapter;
  cardMessageId?: string;
  lastCardUpdateAt: number;
  cardUpdateTimer: ReturnType<typeof setTimeout> | null;
  cardUpdateInFlight: boolean;
  cardUpdateDirty: boolean;
  closed: boolean;
}

const batchesById = new Map<string, PermissionBatchState>();
const batchesByChat = new Map<string, PermissionBatchState>();

/**
 * Per-chat promise chains.
 *
 * `conversation-engine` forwards permission requests fire-and-forget, so a
 * parallel subagent burst enters this module concurrently. “First request vs
 * later request” is decided from the store, and the send → insert-link sequence
 * must not interleave: otherwise every concurrent request sees an empty
 * pending list and each is treated as the first.
 */
const forwardChains = new Map<string, Promise<void>>();

function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = forwardChains.get(chatId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  forwardChains.set(chatId, tail);
  void tail.finally(() => {
    if (forwardChains.get(chatId) === tail) forwardChains.delete(chatId);
  });
  return run;
}

function claimForward(permissionRequestId: string): boolean {
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return false;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }
  return true;
}

function truncateInput(toolInput: Record<string, unknown>): string {
  const inputStr = JSON.stringify(toolInput, null, 2);
  return inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;
}

function forwardInputText(toolName: string, truncatedInput: string): string {
  return [
    `<b>Permission Required</b>`,
    ``,
    `Tool: <code>${escapeHtml(toolName)}</code>`,
    `<pre>${escapeHtml(truncatedInput)}</pre>`,
    ``,
    `Choose an action:`,
  ].join('\n');
}

function individualPermissionButtons(permissionRequestId: string) {
  return [
    [
      { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
      { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
      { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
    ],
    // Deny only fails that one tool call — the agent keeps working on the
    // turn. The aborting variant gets its own row so it isn't a mis-tap.
    [
      { text: 'Deny & Stop', callbackData: `perm:deny_stop:${permissionRequestId}` },
    ],
  ];
}

function batchPermissionButtons(batchId: string) {
  return [
    [
      { text: 'Allow all', callbackData: `perm:batch:${batchId}:allow` },
      { text: 'Allow session all', callbackData: `perm:batch:${batchId}:allow_session` },
      { text: 'Deny all', callbackData: `perm:batch:${batchId}:deny` },
    ],
    [
      { text: 'Deny all & stop', callbackData: `perm:batch:${batchId}:deny_stop` },
    ],
  ];
}

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  await withChatLock(address.chatId, async () => {
    if (!claimForward(permissionRequestId)) return;

    console.log(
      `[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`,
    );

    if (BATCH_CARD_CHANNELS.has(adapter.channelType)) {
      await forwardFeishuPermission(
        adapter,
        address,
        permissionRequestId,
        toolName,
        toolInput,
        sessionId,
        suggestions,
        replyToMessageId,
      );
      return;
    }

    await forwardLegacyPermission(
      adapter,
      address,
      permissionRequestId,
      toolName,
      toolInput,
      sessionId,
      suggestions,
      replyToMessageId,
    );
  });
}

/**
 * Previous one-request-one-message behavior, kept for QQ / WeChat (plain text)
 * and the other button channels (Telegram, Discord). Only Feishu batches.
 */
async function forwardLegacyPermission(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();
  const truncatedInput = truncateInput(toolInput);
  let result: import('./types.js').SendResult;

  if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') {
    const channelLabel = adapter.channelType === 'weixin' ? 'WeChat' : 'QQ';
    // QQ / WeChat: plain text permission prompt with copyable /perm commands (no inline buttons)
    const plainText = [
      `Permission Required`,
      ``,
      `Tool: ${toolName}`,
      truncatedInput,
      ``,
      `Reply:`,
      `1 - Allow once`,
      `2 - Allow session`,
      `3 - Deny this tool call`,
      `4 - Deny and stop the turn`,
      ``,
      `Or use full command:`,
      `/perm allow ${permissionRequestId}`,
      `/perm allow_session ${permissionRequestId}`,
      `/perm deny ${permissionRequestId}`,
      `/perm deny_stop ${permissionRequestId}`,
    ].join('\n');

    const plainMessage: OutboundMessage = {
      address,
      text: plainText,
      parseMode: 'plain',
      replyToMessageId,
    };

    result = await deliver(adapter, plainMessage, { sessionId });
    console.log(
      `[permission-broker] Sent plain-text permission prompt for ${channelLabel}: ${permissionRequestId}`,
    );
  } else {
    const message: OutboundMessage = {
      address,
      text: forwardInputText(toolName, truncatedInput),
      parseMode: 'HTML',
      inlineButtons: individualPermissionButtons(permissionRequestId),
      replyToMessageId,
    };

    result = await deliver(adapter, message, { sessionId });
  }

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Feishu batch-card forwarding.
 *
 * Invariant: every request that reaches the store is in the batch, including
 * the ones that share the batch card's message id. `/perm list` and
 * `/perm ... all` use those links as their source of truth.
 */
async function forwardFeishuPermission(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();
  const truncatedInput = truncateInput(toolInput);

  const pendingBefore = store.listPendingPermissionLinksByChat(address.chatId);
  const firstInFlight = pendingBefore.length === 0;

  let state = firstInFlight ? undefined : batchesByChat.get(address.chatId);
  if (state?.closed) state = undefined;

  // Batch id is written onto links, so after a broker/module reload we can
  // rebuild the in-memory card state from the oldest pending link.
  if (!firstInFlight && !state) {
    const batchId = pendingBefore[0]?.batchId;
    if (batchId) {
      state = createBatchState(
        batchId,
        pendingBefore[0].permissionRequestId,
        adapter,
        address,
      );
    }
  }

  // Links without a batch id (written before batching existed) cannot be
  // grouped safely. Degrade to a full individual card.
  if (!firstInFlight && !state) {
    await sendIndividualFeishuPermission(
      adapter,
      address,
      permissionRequestId,
      toolName,
      truncatedInput,
      sessionId,
      suggestions,
      replyToMessageId,
    );
    return;
  }

  if (firstInFlight) {
    // A state without pending links is a finished batch whose card was never
    // refreshed (for example after a timeout path that does not know the
    // adapter). Retire it before opening a new batch for this chat.
    const previous = batchesByChat.get(address.chatId);
    if (previous) closeBatchState(previous);

    const newState = createBatchState(
      crypto.randomUUID(),
      permissionRequestId,
      adapter,
      address,
    );
    const message: OutboundMessage = {
      address,
      text: forwardInputText(toolName, truncatedInput),
      parseMode: 'HTML',
      inlineButtons: individualPermissionButtons(permissionRequestId),
      replyToMessageId,
    };

    const result = await deliver(adapter, message, { sessionId });
    if (!result.ok || !result.messageId) {
      // The first card never reached the user. Do not create a batch; the next
      // request will be treated as the first again.
      closeBatchState(newState);
      return;
    }

    if (!insertFeishuLink(
      permissionRequestId,
      address,
      result.messageId,
      toolName,
      suggestions,
      newState.batchId,
    )) {
      closeBatchState(newState);
    }
    return;
  }

  // The caller verified `state` exists; keep the non-null narrowing explicit.
  if (!state) return;
  state.adapter = adapter;

  const batchLinks = pendingBefore.filter((link) => link.batchId === state.batchId);

  // Stale active state whose links all belong to an older batch: start over
  // with a full card rather than mixing two batches under one card.
  if (batchLinks.length === 0) {
    closeBatchState(state);
    const newState = createBatchState(
      crypto.randomUUID(),
      permissionRequestId,
      adapter,
      address,
    );
    const result = await deliver(
      adapter,
      {
        address,
        text: forwardInputText(toolName, truncatedInput),
        parseMode: 'HTML',
        inlineButtons: individualPermissionButtons(permissionRequestId),
        replyToMessageId,
      },
      { sessionId },
    );
    if (!result.ok || !result.messageId) {
      closeBatchState(newState);
      return;
    }
    if (!insertFeishuLink(
      permissionRequestId,
      address,
      result.messageId,
      toolName,
      suggestions,
      newState.batchId,
    )) {
      closeBatchState(newState);
    }
    return;
  }

  // The batch card does not exist yet (this is request #2): create it with the
  // projected count including this request, then record the link.
  if (!state.cardMessageId) {
    const projected: Array<Pick<PermissionLinkRecord, 'permissionRequestId' | 'toolName'>> = [
      ...batchLinks.map((link) => ({
        permissionRequestId: link.permissionRequestId,
        toolName: link.toolName,
      })),
      { permissionRequestId, toolName },
    ];

    const message = buildBatchCardMessage(state, projected, address, replyToMessageId);
    const result = await deliver(adapter, message, { sessionId });
    if (result.ok && result.messageId) {
      state.cardMessageId = result.messageId;
      insertFeishuLink(
        permissionRequestId,
        address,
        result.messageId,
        toolName,
        suggestions,
        state.batchId,
      );
      return;
    }

    // Card failed: keep the request actionable via a full card. A later
    // request will retry creating the batch card.
    console.warn(
      `[permission-broker] Batch card send failed; falling back to an individual card for ${permissionRequestId}`,
    );
    await sendIndividualFeishuPermission(
      adapter,
      address,
      permissionRequestId,
      toolName,
      truncatedInput,
      sessionId,
      suggestions,
      replyToMessageId,
      state.batchId,
    );
    return;
  }

  // Request #3..N: share the existing card's message id and refresh its count.
  insertFeishuLink(
    permissionRequestId,
    address,
    state.cardMessageId,
    toolName,
    suggestions,
    state.batchId,
  );
  scheduleBatchCardUpdate(state);
}

function insertFeishuLink(
  permissionRequestId: string,
  address: ChannelAddress,
  messageId: string,
  toolName: string,
  suggestions: unknown[] | undefined,
  batchId?: string,
): boolean {
  const { store } = getBridgeContext();
  try {
    store.insertPermissionLink({
      permissionRequestId,
      channelType: address.channelType,
      chatId: address.chatId,
      messageId,
      toolName,
      suggestions: suggestions ? JSON.stringify(suggestions) : '',
      ...(batchId ? { batchId } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

async function sendIndividualFeishuPermission(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  truncatedInput: string,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
  batchId?: string,
): Promise<void> {
  const result = await deliver(
    adapter,
    {
      address,
      text: forwardInputText(toolName, truncatedInput),
      parseMode: 'HTML',
      inlineButtons: individualPermissionButtons(permissionRequestId),
      replyToMessageId,
    },
    { sessionId },
  );

  if (result.ok && result.messageId) {
    insertFeishuLink(
      permissionRequestId,
      address,
      result.messageId,
      toolName,
      suggestions,
      batchId,
    );
  }
}

// ── Batch card state ─────────────────────────────────────────

function createBatchState(
  batchId: string,
  firstPermissionRequestId: string,
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): PermissionBatchState {
  const state: PermissionBatchState = {
    batchId,
    chatId: address.chatId,
    channelType: adapter.channelType,
    firstPermissionRequestId,
    adapter,
    lastCardUpdateAt: 0,
    cardUpdateTimer: null,
    cardUpdateInFlight: false,
    cardUpdateDirty: false,
    closed: false,
  };
  batchesById.set(batchId, state);
  batchesByChat.set(address.chatId, state);
  return state;
}

function closeBatchState(state: PermissionBatchState): void {
  state.closed = true;
  if (state.cardUpdateTimer) {
    clearTimeout(state.cardUpdateTimer);
    state.cardUpdateTimer = null;
  }
  if (batchesById.get(state.batchId) === state) batchesById.delete(state.batchId);
  if (batchesByChat.get(state.chatId) === state) batchesByChat.delete(state.chatId);
}

function pendingBatchLinks(state: PermissionBatchState): PermissionLinkRecord[] {
  try {
    const { store } = getBridgeContext();
    return store
      .listPendingPermissionLinksByChat(state.chatId)
      .filter((link) => link.batchId === state.batchId);
  } catch {
    return [];
  }
}

function buildBatchCardMessage(
  state: PermissionBatchState,
  links: Array<Pick<PermissionLinkRecord, 'permissionRequestId' | 'toolName'>>,
  address: ChannelAddress,
  replyToMessageId?: string,
): OutboundMessage {
  const additional = links.filter(
    (link) => link.permissionRequestId !== state.firstPermissionRequestId,
  );
  const firstPending = links.some(
    (link) => link.permissionRequestId === state.firstPermissionRequestId,
  );

  if (links.length === 0) {
    return {
      address,
      text: `<b>本批请求已处理</b>\n\n本批权限请求已全部处理。`,
      parseMode: 'HTML',
      cardTitle: '本批请求已处理',
      replyToMessageId,
    };
  }

  if (additional.length === 0) {
    return {
      address,
      text: [
        `<b>本批暂无其他待批准请求</b>`,
        ``,
        `首条请求请在上方完整卡片中处理。`,
      ].join('\n'),
      parseMode: 'HTML',
      cardTitle: '本批暂无其他待批准请求',
      replyToMessageId,
    };
  }

  const lines = [
    `<b>还有 ${additional.length} 条待批准</b>`,
    ``,
    firstPending
      ? `批量操作会同时处理上方首条完整卡片中的请求和本卡的请求。`
      : `批量操作会处理本卡中的全部待批请求。`,
    ``,
  ];

  additional.slice(0, BATCH_CARD_LIST_LIMIT).forEach((link, index) => {
    lines.push(`${index + 1}. <code>${escapeHtml(link.toolName || 'unknown tool')}</code>`);
  });

  if (additional.length > BATCH_CARD_LIST_LIMIT) {
    lines.push(`… 另有 ${additional.length - BATCH_CARD_LIST_LIMIT} 条，回复 /perm list 查看全部。`);
  }

  lines.push('');
  lines.push('逐条处理：`/perm list` → `/perm allow|allow_session|deny|deny_stop #编号`。');

  return {
    address,
    text: lines.join('\n'),
    parseMode: 'HTML',
    inlineButtons: batchPermissionButtons(state.batchId),
    cardTitle: `还有 ${additional.length} 条待批准`,
    replyToMessageId,
  };
}

/**
 * Schedule a batch-card refresh. Bursts of 30+ subagent requests coalesce into
 * at most one edit per `BATCH_CARD_UPDATE_INTERVAL_MS`.
 */
function scheduleBatchCardUpdate(state: PermissionBatchState, immediate = false): void {
  if (state.closed) return;

  if (!state.cardMessageId) {
    // No card to edit yet. Leave the state in place: a concurrent forward may
    // be about to create the batch card, and a later first-request path will
    // retire this state if the batch ended without one.
    return;
  }

  state.cardUpdateDirty = true;
  if (state.cardUpdateInFlight) return;

  if (state.cardUpdateTimer) {
    if (!immediate) return;
    clearTimeout(state.cardUpdateTimer);
    state.cardUpdateTimer = null;
  }

  const wait = immediate
    ? 0
    : Math.max(0, state.lastCardUpdateAt + BATCH_CARD_UPDATE_INTERVAL_MS - Date.now());

  if (wait > 0) {
    state.cardUpdateTimer = setTimeout(() => {
      state.cardUpdateTimer = null;
      void flushBatchCardUpdate(state);
    }, wait);
    if (typeof state.cardUpdateTimer.unref === 'function') state.cardUpdateTimer.unref();
    return;
  }

  void flushBatchCardUpdate(state);
}

async function flushBatchCardUpdate(state: PermissionBatchState): Promise<void> {
  if (state.closed || !state.cardMessageId) return;
  if (state.cardUpdateInFlight) {
    state.cardUpdateDirty = true;
    return;
  }

  state.cardUpdateDirty = false;
  state.cardUpdateInFlight = true;
  state.lastCardUpdateAt = Date.now();

  const links = pendingBatchLinks(state);
  const message = buildBatchCardMessage(
    state,
    links,
    { channelType: state.channelType, chatId: state.chatId },
  );

  try {
    const result = await state.adapter.updateMessage(state.cardMessageId, message);
    if (!result.ok) {
      console.warn(
        `[permission-broker] Batch card update failed for ${state.batchId}: ${result.error || 'unknown error'}`,
      );
    }
  } catch (err) {
    console.warn(
      '[permission-broker] Batch card update error:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    state.cardUpdateInFlight = false;
    if (links.length === 0) {
      closeBatchState(state);
    } else if (state.cardUpdateDirty && !state.closed) {
      scheduleBatchCardUpdate(state);
    }
  }
}

/** Called after a single permission link is resolved so N stays accurate. */
function refreshBatchAfterResolution(link: PermissionLinkRecord): void {
  if (!link.batchId) return;
  const state = batchesById.get(link.batchId);
  if (!state || state.closed) return;
  scheduleBatchCardUpdate(state);
}

/**
 * Tell the broker that a link was resolved outside the callback path.
 *
 * The host marks links resolved when a permission times out (the turn's
 * `canUseTool` promise rejects after 5 minutes). Without this, the batch card
 * would keep counting a request that is no longer pending.
 */
export function notifyPermissionLinkResolved(permissionRequestId: string): void {
  try {
    const { store } = getBridgeContext();
    const link = store.getPermissionLink(permissionRequestId);
    if (link) refreshBatchAfterResolution(link);
  } catch { /* best effort: never block the timeout deny */ }
}

// ── Callback parsing & resolution ────────────────────────────

/**
 * Parsed permission callback.
 *
 * Individual buttons: `perm:<action>:<permissionRequestId>`
 * Batch card buttons: `perm:batch:<batchId>:<action>`
 */
export interface ParsedPermissionCallback {
  action: string;
  permissionRequestId?: string;
  batchId?: string;
  isBatch: boolean;
}

/**
 * Parse a `perm:<action>:<permissionRequestId>` or
 * `perm:batch:<batchId>:<action>` payload.
 *
 * Exported so callers can branch on the action — bridge-manager aborts the
 * in-flight turn for `deny_stop` — without duplicating the wire format.
 */
export function parsePermissionCallback(callbackData: string): ParsedPermissionCallback | null {
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return null;

  if (parts[1] === 'batch') {
    if (parts.length < 4) return null;
    const action = parts[parts.length - 1];
    const batchId = parts.slice(2, -1).join(':');
    if (!action || !batchId) return null;
    return { action, batchId, isBatch: true };
  }

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons
  if (!action || !permissionRequestId) return null;
  return { action, permissionRequestId, isBatch: false };
}

export interface PermissionCallbackOutcome {
  handled: boolean;
  action?: PermissionAction;
  kind: 'single' | 'batch';
  /** Number of permission links this callback actually resolved. */
  resolvedCount: number;
  /** Number of pending links the callback targeted before resolution. */
  pendingCount: number;
  batchId?: string;
}

const UNHANDLED: PermissionCallbackOutcome = {
  handled: false,
  kind: 'single',
  resolvedCount: 0,
  pendingCount: 0,
};

/**
 * Handle a permission callback from an inline button press.
 *
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled. Callers that need
 * the batch size (for the confirmation message) use the detailed variant.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
  adapter?: BaseChannelAdapter,
): boolean {
  return handlePermissionCallbackDetailed(
    callbackData,
    callbackChatId,
    callbackMessageId,
    adapter,
  ).handled;
}

export function handlePermissionCallbackDetailed(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
  adapter?: BaseChannelAdapter,
): PermissionCallbackOutcome {
  const parsed = parsePermissionCallback(callbackData);
  if (!parsed) return UNHANDLED;

  const { action } = parsed;

  // Validate the action BEFORE claiming any link. Otherwise an unknown action
  // would mark permissions resolved without resolving the pending promises,
  // leaving the turn to hang until the 5-minute timeout.
  if (!isPermissionAction(action)) {
    console.warn(`[permission-broker] Unknown permission action: ${action}`);
    return UNHANDLED;
  }

  if (parsed.isBatch) {
    if (!parsed.batchId) return UNHANDLED;
    return resolveBatchCallback(
      parsed.batchId,
      action,
      callbackChatId,
      callbackMessageId,
      adapter,
    );
  }

  if (!parsed.permissionRequestId) return UNHANDLED;
  return resolveSingleCallback(
    parsed.permissionRequestId,
    action,
    callbackChatId,
    callbackMessageId,
  );
}

function resolveSingleCallback(
  permissionRequestId: string,
  action: PermissionAction,
  callbackChatId: string,
  callbackMessageId?: string,
): PermissionCallbackOutcome {
  const { store } = getBridgeContext();

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return UNHANDLED;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return UNHANDLED;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return UNHANDLED;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return UNHANDLED;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return UNHANDLED;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return UNHANDLED;
  }

  const resolved = resolvePermissionLink(link, action, permissionRequestId);
  refreshBatchAfterResolution(link);

  return {
    handled: resolved,
    action,
    kind: 'single',
    resolvedCount: resolved ? 1 : 0,
    pendingCount: 1,
    ...(link.batchId ? { batchId: link.batchId } : {}),
  };
}

function resolveBatchCallback(
  batchId: string,
  action: PermissionAction,
  callbackChatId: string,
  callbackMessageId: string | undefined,
  adapter: BaseChannelAdapter | undefined,
): PermissionCallbackOutcome {
  const { store } = getBridgeContext();

  const pending = store
    .listPendingPermissionLinksByChat(callbackChatId)
    .filter((link) => link.batchId === batchId);

  if (pending.length === 0) {
    console.warn(
      `[permission-broker] No pending permissions for batch ${batchId} in chat ${callbackChatId}`,
    );
    return { ...UNHANDLED, kind: 'batch', action, batchId };
  }

  const state = batchesById.get(batchId);
  if (state) {
    if (state.chatId !== callbackChatId) {
      console.warn(
        `[permission-broker] Batch chat ID mismatch: expected ${state.chatId}, got ${callbackChatId}`,
      );
      return { ...UNHANDLED, kind: 'batch', action, batchId };
    }
    // The batch card is the only message whose buttons carry this batch id.
    // Validate when we still know its id; after a module reload the batch id
    // plus chat id are still sufficient (pending promises are process-local).
    if (callbackMessageId && state.cardMessageId && callbackMessageId !== state.cardMessageId) {
      console.warn(
        `[permission-broker] Batch message ID mismatch: expected ${state.cardMessageId}, got ${callbackMessageId}`,
      );
      return { ...UNHANDLED, kind: 'batch', action, batchId };
    }
    if (adapter) state.adapter = adapter;
  }

  let resolvedCount = 0;
  let resolvedFirstLink: PermissionLinkRecord | undefined;
  for (const link of pending) {
    let claimed = false;
    try {
      claimed = store.markPermissionLinkResolved(link.permissionRequestId);
    } catch { /* try the next one */ }
    if (!claimed) continue;
    try {
      if (resolvePermissionLink(link, action)) {
        resolvedCount++;
        if (link.permissionRequestId === state?.firstPermissionRequestId) {
          resolvedFirstLink = link;
        }
      }
    } catch (err) {
      console.warn(
        `[permission-broker] Failed to resolve ${link.permissionRequestId} in batch ${batchId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const outcome: PermissionCallbackOutcome = {
    handled: resolvedCount > 0,
    action,
    kind: 'batch',
    resolvedCount,
    pendingCount: pending.length,
    batchId,
  };

  if (state && resolvedCount > 0) {
    // The first request has its own full card. A batch action resolves it too,
    // so retire that card as well; otherwise it keeps offering buttons for a
    // request that is already settled.
    if (resolvedFirstLink && resolvedFirstLink.messageId !== state.cardMessageId) {
      void state.adapter.updateMessage(resolvedFirstLink.messageId, {
        address: { channelType: state.channelType, chatId: state.chatId },
        text: '<b>本批请求已处理</b>\n\n该请求已随整批处理。',
        parseMode: 'HTML',
        cardTitle: '本批请求已处理',
      }).catch(() => { /* best effort */ });
    }

    // The card's final state is part of the UX: show "已处理" and drop the
    // buttons immediately, rather than leaving a clickable stale card.
    scheduleBatchCardUpdate(state, true);
  }

  return outcome;
}

function resolvePermissionLink(
  link: PermissionLinkRecord,
  action: PermissionAction,
  permissionRequestId = link.permissionRequestId,
): boolean {
  const { permissions } = getBridgeContext();

  switch (action) {
    case 'allow':
      return permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
      });

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      return permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
    }

    case 'deny':
    case 'deny_stop':
      // `deny_stop` resolves identically; bridge-manager additionally aborts the
      // in-flight turn once this returns true.
      return permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: DENY_MESSAGE,
      });

    default:
      return false;
  }
}

/** Test hook: drop all in-memory batch state between unit tests. */
export const _testOnly = {
  resetBatchState(): void {
    for (const state of batchesByChat.values()) {
      if (state.cardUpdateTimer) clearTimeout(state.cardUpdateTimer);
    }
    batchesById.clear();
    batchesByChat.clear();
    forwardChains.clear();
    recentPermissionForwards.clear();
  },
};
