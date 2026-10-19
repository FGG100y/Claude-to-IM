/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3/4) for
 * feishu/qq/weixin channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" (or "4") behind
 * the session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!broker.permissionActionForShortcut(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Wall-clock start of the active turn, used by /status. */
  activeTaskStartedAt: Map<string, number>;
  /**
   * Per-session epoch. `/stop` (and `deny_stop`) bumps it so messages that
   * were already queued behind the cancelled turn are dropped instead of
   * starting a fresh turn after the abort.
   */
  sessionEpochs: Map<string, number>;
  /** Regular messages currently waiting on the session lock. */
  queuedTurns: Map<string, number>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

/** At most this many regular messages may wait behind one active turn. */
const MAX_QUEUED_TURNS = 3;

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      activeTaskStartedAt: new Map(),
      sessionEpochs: new Map(),
      queuedTurns: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill fields for states created before they existed (HMR).
  const state = g[GLOBAL_KEY];
  if (!state.sessionLocks) state.sessionLocks = new Map();
  if (!state.activeTaskStartedAt) state.activeTaskStartedAt = new Map();
  if (!state.sessionEpochs) state.sessionEpochs = new Map();
  if (!state.queuedTurns) state.queuedTurns = new Map();
  return state;
}

/**
 * Normalize text before command detection: full-width slash/digits, zero-width
 * joiners and other Unicode variants. Mobile Feishu clients occasionally insert
 * these, which used to turn `/stop` into a regular queued message.
 */
function normalizeCommandText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function sessionEpoch(sessionId: string): number {
  return getState().sessionEpochs.get(sessionId) ?? 0;
}

function bumpSessionEpoch(sessionId: string): number {
  const state = getState();
  const next = (state.sessionEpochs.get(sessionId) ?? 0) + 1;
  state.sessionEpochs.set(sessionId, next);
  return next;
}

function queuedTurnCount(sessionId: string): number {
  return getState().queuedTurns.get(sessionId) ?? 0;
}

function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function ackInbound(adapter: BaseChannelAdapter, msg: InboundMessage): void {
  if (msg.updateId != null) adapter.acknowledgeUpdate?.(msg.updateId);
}

function auditDroppedTurn(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  reason: string,
): void {
  try {
    getBridgeContext().store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[DROPPED] ${reason}`,
    });
  } catch { /* best effort */ }
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3/4) for feishu/qq/weixin MUST run
        // outside the session lock. The current session is blocked waiting for
        // the permission to be resolved; if "1" (or "4") enters the session
        // lock queue it deadlocks (permission waits for "1", "1" waits for
        // lock release).
        const commandText = normalizeCommandText(msg.text);
        if (
          msg.callbackData ||
          commandText.startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, commandText, msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          queueRegularTurn(adapter, msg);
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Queue a regular message behind the session's active turn.
 *
 * Each queued turn captures the session epoch. `/stop` bumps the epoch before
 * aborting, so anything already queued is discarded instead of becoming a new
 * turn after the abort ("the agent restarted itself" incident).
 */
function queueRegularTurn(adapter: BaseChannelAdapter, msg: InboundMessage): void {
  const state = getState();
  const binding = router.resolve(msg.address);
  const sessionId = binding.codepilotSessionId;
  const epoch = sessionEpoch(sessionId);

  if (queuedTurnCount(sessionId) >= MAX_QUEUED_TURNS) {
    dropQueuedTurn(adapter, msg, 'queue full; send /status or /stop');
    return;
  }

  state.queuedTurns.set(sessionId, queuedTurnCount(sessionId) + 1);

  // Fire-and-forget into session lock — loop continues to accept
  // messages for other sessions immediately.
  processWithSessionLock(sessionId, async () => {
    state.queuedTurns.set(sessionId, Math.max(0, queuedTurnCount(sessionId) - 1));

    if (sessionEpoch(sessionId) !== epoch) {
      dropQueuedTurn(adapter, msg, 'cancelled by /stop (stale session epoch)');
      return;
    }

    await handleMessage(adapter, msg);
  }).catch(err => {
    console.error(`[bridge-manager] Session ${sessionId.slice(0, 8)} error:`, err);
  });
}

/**
 * Drop a queued message, acknowledge its update offset, and tell the user why.
 * Deliberately does not start a new turn.
 */
function dropQueuedTurn(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  reason: string,
): void {
  ackInbound(adapter, msg);
  auditDroppedTurn(adapter, msg, `queued message dropped: ${reason}`);
  void deliver(adapter, {
    address: msg.address,
    text: `Queued message cancelled: ${reason}. Send /status for progress or /stop to cancel the current turn.`,
    parseMode: 'plain',
    replyToMessageId: msg.messageId,
  }).catch(() => { /* best effort */ });
}

/**
 * Abort the turn currently running for this chat, if any. Mirrors `/stop`.
 */
function abortActiveTask(address: InboundMessage['address']): boolean {
  try {
    const binding = router.resolve(address);
    const state = getState();
    const taskAbort = state.activeTasks.get(binding.codepilotSessionId);
    if (taskAbort) {
      taskAbort.abort();
      state.activeTasks.delete(binding.codepilotSessionId);
      state.activeTaskStartedAt.delete(binding.codepilotSessionId);
      return true;
    }
  } catch (err) {
    console.warn('[bridge-manager] Failed to abort active task:', err instanceof Error ? err.message : err);
  }
  return false;
}

/**
 * Record a permission decision, then post-process the action.
 *
 * Denying a tool call only fails that one call — the agent keeps working on the
 * turn — so say so explicitly, and let `deny_stop` additionally abort it.
 * Returns false when the callback was rejected (unknown id, wrong chat, stale).
 */
async function respondToPermission(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  callbackData: string,
): Promise<boolean> {
  const parsed = broker.parsePermissionCallback(callbackData);
  const outcome = broker.handlePermissionCallbackDetailed(
    callbackData,
    msg.address.chatId,
    msg.callbackMessageId,
    adapter,
  );
  if (!outcome.handled) return false;

  const singleConfirmations: Record<string, string> = {
    allow: 'Allowed. Claude is continuing this turn.',
    allow_session: 'Allowed for this session. Claude is continuing this turn.',
    deny: 'Denied this tool call. Claude keeps working on the current turn — send /stop to abort it.',
    deny_stop: 'Denied this tool call and stopping the current turn…',
  };

  const batchConfirmations: Record<string, string> = {
    allow: `Allowed all ${outcome.resolvedCount} pending requests. Claude is continuing this turn.`,
    allow_session: `Allowed all ${outcome.resolvedCount} pending requests for this session. Claude is continuing this turn.`,
    deny: `Denied all ${outcome.resolvedCount} pending requests. Claude keeps working on the current turn — send /stop to abort it.`,
    deny_stop: `Denied all ${outcome.resolvedCount} pending requests and stopping the current turn…`,
  };

  const confirmations = outcome.kind === 'batch' ? batchConfirmations : singleConfirmations;

  await deliver(adapter, {
    address: msg.address,
    text: (parsed && confirmations[parsed.action]) || 'Permission response recorded.',
    parseMode: 'plain',
  });

  // The permission is resolved above, so the waiting canUseTool() unblocks
  // cleanly and nothing is left pending when the turn is torn down.
  if (parsed?.action === 'deny_stop') {
    // Drop messages that were waiting behind this turn; otherwise they would
    // start a fresh turn immediately after the abort.
    const binding = router.resolve(msg.address);
    bumpSessionEpoch(binding.codepilotSessionId);
    abortActiveTask(msg.address);
  }

  return true;
}

/**
 * Keep only a short, single-line description of what a tool was asked to do.
 * This is only shown for failures; successful calls are aggregated by count.
 */
function summarizeToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (obj[key] != null && obj[key] !== '') return obj[key];
    }
    return undefined;
  };

  let value: unknown;
  switch (toolName) {
    case 'Bash':
      value = pick('command', 'description');
      break;
    case 'WebFetch':
      value = pick('url');
      break;
    case 'WebSearch':
      value = pick('query');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      value = pick('file_path', 'notebook_path', 'path');
      break;
    case 'Agent':
      value = pick('description', 'prompt');
      break;
    default:
      value = pick('command', 'url', 'query', 'file_path', 'description', 'prompt');
      if (value == null) value = obj;
      break;
  }

  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return truncateOneLine(redactSensitive(text), 120);
}

function redactSensitive(text: string): string {
  return text
    .replace(/\b((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)?\s*)[^\s,;]+/gi, '$1***')
    .replace(/(--(?:password|token|secret)\s+)[^\s,;]+/gi, '$1***');
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? oneLine.slice(0, maxChars - 1) + '…' : oneLine;
}

function classifyToolFailure(
  result: unknown,
  isError: boolean,
): { kind: NonNullable<ToolCallInfo['errorKind']>; message: string } | undefined {
  if (!isError) return undefined;
  const raw = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const lower = raw.toLowerCase();

  let kind: NonNullable<ToolCallInfo['errorKind']> = 'tool_error';
  if (lower.includes('permission request timed out')) {
    kind = 'timeout';
  } else if (
    lower.includes('declined this action')
    || lower.includes('user declined')
    || lower.includes('denied via im bridge')
    || lower.includes('permission denied')
  ) {
    kind = 'denied';
  } else if (lower.includes('policy') || lower.includes('blocked by')) {
    kind = 'policy';
  }

  const message = truncateOneLine(
    redactSensitive(raw) || 'Tool returned an error',
    200,
  );
  return { kind, message };
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    await respondToPermission(adapter, msg, msg.callbackData);
    ack();
    return;
  }

  const rawText = msg.text.trim();
  // Normalize before command detection: full-width slash, zero-width characters
  // and NFKC variants must still be recognized as `/stop` etc.
  const commandText = normalizeCommandText(msg.text);
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", "3", or "4" and there is exactly one pending
  // permission for this chat, map it:
  // 1→allow, 2→allow_session, 3→deny, 4→deny_stop.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // Use the same normalization as command detection so full-width digits and
    // zero-width joiners still map to 1/2/3/4.
    const normalized = commandText;
    const shortcutAction = broker.permissionActionForShortcut(normalized);
    if (shortcutAction) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const action = shortcutAction;
        const permId = pendingLinks[0].permissionRequestId;
        // Shares the callback path so `4` aborts the turn the same way the
        // "Deny & Stop" button does.
        const handled = await respondToPermission(adapter, msg, `perm:${action}:${permId}`);
        if (!handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Reply /perm list to see them, then /perm allow|allow_session|deny|deny_stop <number>.`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && !broker.permissionActionForShortcut(rawText)) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (commandText.startsWith('/')) {
    await handleCommand(adapter, msg, commandText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);
  state.activeTaskStartedAt.set(binding.codepilotSessionId, Date.now());

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (
    toolId: string,
    toolName: string,
    status: 'running' | 'complete' | 'error',
    detail?: engine.ToolEventDetail,
  ) => {
    const existing = toolCallTracker.get(toolId);
    if (toolName) {
      toolCallTracker.set(toolId, {
        id: toolId,
        name: toolName,
        status,
        inputSummary: summarizeToolInput(toolName, detail?.input) ?? existing?.inputSummary,
      });
    } else if (existing) {
      // tool_result doesn't carry name — update the existing entry.
      existing.status = status;
      if (status === 'error') {
        const failure = classifyToolFailure(detail?.result, detail?.isError ?? true);
        if (failure) {
          existing.errorKind = failure.kind;
          existing.errorMessage = failure.message;
        }
      }
    } else {
      // A result without its tool_use event (e.g. resumed/unknown call).
      const failure = status === 'error'
        ? classifyToolFailure(detail?.result, detail?.isError ?? true)
        : undefined;
      toolCallTracker.set(toolId, {
        id: toolId,
        name: 'unknown tool',
        status,
        ...(failure ? { errorKind: failure.kind, errorMessage: failure.message } : {}),
      });
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      // Close this turn's streaming card before the prompt is posted. A card
      // keeps the position where it was created, so the prompt always lands
      // below it — leaving the post-approval output to stream into a card the
      // user would have to scroll back up past to read.
      if (hasStreamingCards && adapter.onStreamBreak) {
        try {
          await adapter.onStreamBreak(msg.address.chatId);
        } catch (err) {
          console.warn('[bridge-manager] Stream break failed:', err instanceof Error ? err.message : err);
        }
      }

      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        // A user-initiated abort (/stop, or the Deny & Stop permission button)
        // is not a failure. The adapter renders 'interrupted' with a neutral
        // footer, so the card stops claiming the turn errored out.
        const status = taskAbort.signal.aborted
          ? 'interrupted'
          : result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // An intentional abort (/stop) is not a broken session: keep the existing
    // resume ID instead of clearing it. Only real errors clear a stale ID.
    if (binding.id) {
      try {
        const hasErrorForSession = result.hasError && !taskAbort.signal.aborted;
        const update = computeSdkSessionUpdate(result.sdkSessionId, hasErrorForSession);
        if (update !== null) {
          store.updateChannelBinding(
            binding.id,
            { sdkSessionId: update },
            binding.codepilotSessionId,
          );
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    state.activeTaskStartedAt.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Commands bypass the session lock, so record them explicitly. This lets us
  // distinguish "command never arrived" from "command ran" in the audit trail.
  try {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[CMD] ${command}${args ? ` ${args.slice(0, 120)}` : ''}`,
    });
  } catch { /* best effort */ }

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny|deny_stop all - Respond to every pending request',
        '/perm list - List pending permission requests',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      // Invalidate queued turns for the old session before switching bindings.
      bumpSessionEpoch(oldBinding.codepilotSessionId);
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
        st.activeTaskStartedAt.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const sessionId = binding.codepilotSessionId;
      const startedAt = st.activeTaskStartedAt.get(sessionId);
      const active = st.activeTasks.has(sessionId);
      const elapsed = active && startedAt
        ? formatElapsedMs(Date.now() - startedAt)
        : '-';
      const pendingPerms = store.listPendingPermissionLinksByChat(msg.address.chatId).length;
      const lastMessageAt = st.adapterMeta.get(adapter.channelType)?.lastMessageAt ?? '-';
      const health = adapter.getHealth?.() ?? null;
      const buildSha = process.env.CTI_BUILD_SHA || 'unknown';
      const buildAt = process.env.CTI_BUILD_AT || 'unknown';
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${sessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Turn: <b>${active ? 'running' : 'idle'}</b>${active ? ` · ${elapsed}` : ''}`,
        `Queue: <b>${queuedTurnCount(sessionId)}</b>`,
        `Pending permissions: <b>${pendingPerms}</b>`,
        `Transport: <b>${health ? (health.connected ? 'running' : 'stopped') : 'unknown'}</b>${health?.detail ? ` · ${escapeHtml(health.detail)}` : ''}`,
        `Last message: <code>${escapeHtml(lastMessageAt)}</code>`,
        `Last event: <code>${escapeHtml(health?.lastEventAt || lastMessageAt)}</code>`,
        `Build: <code>${escapeHtml(buildSha)}</code> (${escapeHtml(buildAt)})`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const queued = queuedTurnCount(binding.codepilotSessionId);
      // Invalidate anything already queued before aborting: those messages
      // belong to the turn the user just cancelled and must not start a new one.
      bumpSessionEpoch(binding.codepilotSessionId);
      const stopped = abortActiveTask(msg.address);
      if (stopped) {
        response = queued > 0
          ? `Stopping current task... Cancelled ${queued} queued message(s).`
          : 'Stopping current task...';
      } else if (queued > 0) {
        response = `Cancelled ${queued} queued message(s).`;
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage:
      //   /perm list                                            - list pending permissions
      //   /perm allow|allow_session|deny|deny_stop <id>         - respond by permission id
      //   /perm allow|allow_session|deny|deny_stop <number>     - respond by /perm list number
      //   /perm allow|allow_session|deny|deny_stop all          - respond to every pending one
      // `deny_stop` also aborts the in-flight turn, like the card button.
      const pendingPerms = store.listPendingPermissionLinksByChat(msg.address.chatId);
      const permParts = args.split(/\s+/).filter(Boolean);
      const permAction = (permParts[0] || '').toLowerCase();

      // `/perm` or `/perm list` → show what is pending so the user can act on it.
      if (!permAction || permAction === 'list') {
        if (pendingPerms.length === 0) {
          response = 'No pending permissions.';
        } else {
          const lines = [`<b>Pending permissions (${pendingPerms.length}):</b>`, ''];
          pendingPerms.forEach((link, i) => {
            const tool = link.toolName ? escapeHtml(link.toolName) : 'unknown tool';
            lines.push(`${i + 1}. ${tool}`);
            lines.push(`   <code>${escapeHtml(link.permissionRequestId)}</code>`);
          });
          lines.push('');
          lines.push('Reply <code>/perm allow|allow_session|deny|deny_stop &lt;number&gt;</code>, or <code>... all</code>.');
          response = lines.join('\n');
        }
        break;
      }

      const permTarget = permParts.slice(1).join(' ').trim();
      if (!permTarget || !broker.isPermissionAction(permAction)) {
        response = 'Usage: /perm list | /perm allow|allow_session|deny|deny_stop &lt;number|id|all&gt;';
        break;
      }

      const resolvePerm = (permId: string): boolean => {
        const resolved = broker.handlePermissionCallback(
          `perm:${permAction}:${permId}`,
          msg.address.chatId,
          undefined,
          adapter,
        );
        // broker resolves `deny_stop` exactly like `deny`; aborting the turn is
        // ours to do, and only once something actually resolved. Idempotent, so
        // the `all` loop aborting on its first success is fine.
        if (resolved && permAction === 'deny_stop') {
          const binding = router.resolve(msg.address);
          bumpSessionEpoch(binding.codepilotSessionId);
          abortActiveTask(msg.address);
        }
        return resolved;
      };

      if (permTarget === 'all') {
        if (pendingPerms.length === 0) {
          response = 'No pending permissions.';
          break;
        }
        let ok = 0;
        for (const link of pendingPerms) {
          if (resolvePerm(link.permissionRequestId)) ok++;
        }
        response = `Permission ${permAction}: recorded for ${ok}/${pendingPerms.length} request(s).`;
        break;
      }

      // Accept a 1-based number from `/perm list`, or a raw permission id.
      let permId = permTarget;
      if (/^\d+$/.test(permTarget)) {
        const idx = Number(permTarget) - 1;
        if (idx < 0 || idx >= pendingPerms.length) {
          response = `No pending permission #${permTarget}. Send /perm list to see the current list.`;
          break;
        }
        permId = pendingPerms[idx].permissionRequestId;
      }

      const handled = resolvePerm(permId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny|deny_stop all - Respond to every pending request',
        '/perm list - List pending permission requests',
        '1/2/3/4 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop. The shortcut router is exported
// too: its "4" handling is what keeps deny_stop out of the session lock.
/** @internal */
export const _testOnly = {
  handleMessage,
  isNumericPermissionShortcut,
  normalizeCommandText,
  queueRegularTurn,
  getState,
  summarizeToolInput,
  classifyToolFailure,
};
