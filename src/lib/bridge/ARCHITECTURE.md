# Claude-to-IM Architecture

## Module Dependency Graph

```
bridge-manager.ts (orchestrator)
├── channel-adapter.ts (abstract base + registry)
│   └── adapters/
│       ├── telegram-adapter.ts
│       ├── discord-adapter.ts
│       └── feishu-adapter.ts
├── channel-router.ts (address → session binding)
├── conversation-engine.ts (LLM stream processing)
├── permission-broker.ts (tool approval forwarding)
├── delivery-layer.ts (reliable outbound delivery)
├── markdown/
│   ├── ir.ts (intermediate representation)
│   ├── render.ts (generic renderer)
│   ├── telegram.ts (Markdown → HTML chunks)
│   ├── discord.ts (native Discord markdown)
│   └── feishu.ts (Feishu cards/posts)
├── security/
│   ├── validators.ts (input validation)
│   └── rate-limiter.ts (token bucket per chat)
├── types.ts (shared type definitions)
├── host.ts (host interface definitions)
└── context.ts (DI container)
```

## Dependency Injection

All host dependencies are abstracted through interfaces in `host.ts` and accessed via the `BridgeContext` singleton in `context.ts`.

```
┌─────────────┐   implements   ┌──────────────────────┐
│ host.ts     │◄──────────────│ hosts/codepilot.ts   │
│ (interfaces)│                │ (CodePilot adapter)  │
└──────┬──────┘                └──────────────────────┘
       │ injected via
       ▼
┌──────────────┐   used by   ┌──────────────────────────┐
│ context.ts   │────────────►│ All bridge modules       │
│ (DI container)│             │ (via getBridgeContext())  │
└──────────────┘              └──────────────────────────┘
```

**No bridge module imports directly from the host application.** All access goes through `getBridgeContext().store`, `.llm`, `.permissions`, or `.lifecycle`.

## Message Flow

### Inbound (IM → LLM)

1. **Adapter** polls/listens for messages, enqueues `InboundMessage`
2. **Bridge Manager** calls `adapter.consumeOne()`, dispatches to `handleMessage()`
3. Per-session locking via `processWithSessionLock()` — serializes same-session, parallelizes different-session
4. **Channel Router** resolves `ChannelAddress` → `ChannelBinding` (creates session if needed)
5. **Conversation Engine** acquires DB session lock, sends prompt to LLM via `llm.streamChat()`
6. SSE stream is consumed server-side:
   - `text` events → accumulated response + streaming preview
   - `permission_request` events → forwarded immediately via Permission Broker
   - `status`/`result` events → SDK session ID capture
7. Response text saved to DB, returned to Bridge Manager

### Outbound (LLM → IM)

1. **Bridge Manager** receives response text, dispatches to `deliverResponse()`
2. Platform-specific rendering: Telegram (HTML chunks), Discord (native markdown), Feishu (cards)
3. **Delivery Layer** handles chunking, rate limiting, retry, dedup, audit logging
4. **Adapter** sends via platform API

### Permission Flow

1. LLM stream emits `permission_request` event (stream blocks)
2. **Permission Broker** formats interactive message with inline buttons
3. **Delivery Layer** sends to IM, records `PermissionLink` in store
4. User clicks button → adapter emits callback `InboundMessage`
5. **Bridge Manager** routes callback to `broker.handlePermissionCallback()`
6. **Permission Broker** validates origin (chat + message ID match), claims atomically, resolves via `PermissionGateway`
7. Stream unblocks and continues

#### Feishu batch cards

Feishu batches permission prompts per chat instead of posting one card per
request:

1. The first pending request gets the full individual card.
2. Later requests do not send new cards. The broker creates one editable
   “还有 N 条” card and patches it (`im.message.patch`, `update_multi: true`)
   as the pending count grows.
3. Batch buttons use `perm:batch:<batchId>:<action>` and resolve every
   still-pending link carrying that `batchId`:
   `allow`, `allow_session`, `deny`, `deny_stop`.
4. Every batched request still gets a complete `PermissionLink` (with
   `batchId`), so `/perm list` and `/perm <action> all` keep working.
5. Forwards are serialized per chat so a concurrent subagent burst cannot
   classify multiple requests as “the first”.

Other channels keep the one-request-one-message flow.

## Key Design Decisions

### globalThis Singletons
Bridge Manager state lives on `globalThis` to survive Next.js HMR. The DI context also uses `globalThis`.

### Deferred Offset Acknowledgement
Telegram adapter separates `fetchOffset` (API watermark) from `committedOffset` (DB). Offset only advances after `handleMessage()` completes, preventing message loss on crash.

### Streaming Preview Throttling
Preview drafts use configurable interval (700ms Telegram, 1500ms Discord) + minimum delta chars. Trailing-edge timer ensures the latest text is always sent. On permanent API failure, preview degrades gracefully (stops sending, doesn't retry).

### Session Lock Chains
`processWithSessionLock()` uses Promise chaining — not mutual exclusion — so different sessions process concurrently while same-session messages serialize. Lock cleanup happens in `.finally()`.

### Turn Cancellation and the Session Queue

Regular messages are serialized per session. Each queued turn captures the
session's `stopEpoch`; `/stop` (and the `Deny & Stop` permission action) bumps
that epoch before aborting the active turn. Queued messages from the old epoch
are acknowledged, audited as `[DROPPED]`, and answered with a cancellation
notice instead of starting a new turn after the abort. The queue is capped at
three messages.

`/stop` is a soft cancel: the host keeps the SDK `Query` and calls
`Query.interrupt()`, waiting three seconds before closing that turn's transport.
It never shuts down the daemon, and it preserves the session's `sdkSessionId`
and stored history. Stopping the daemon is the separate local
`deploy/ctl.sh stop` operation.

`/status` is handled outside the session lock and reports the active turn,
elapsed time, queue depth, pending permissions, transport health, last event
time and build identity.

### Tool Progress Summary

Successful tool calls are aggregated into a count; running calls are grouped by
tool name. Failures keep one line of context: tool name, a short input summary
(Bash command, WebFetch URL, WebSearch query, file path) and a reason (user
denied, permission timeout, policy, or tool error). At most three failure
details are shown, with the rest folded into a count. Inputs are truncated and
redacted for obvious secrets. The final card renders this summary in a separate
notation element, and the streaming adapter only flushes when the summary
actually changes.
