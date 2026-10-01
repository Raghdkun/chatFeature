# Realtime channels and events (Reverb)

> Status: contract v1 (written ahead of P4). Owners: P4 4B (server events + channel auth), 4C (dashboard), 4D (embed panel);
> P5 (presence, push) and P6 (WhatsApp admin channel) extend it additively. Detail/rationale: [../realtime.md](../realtime.md).

Transport: Laravel Reverb (Pusher protocol). Server broadcasts to `reverb:8080` internally; clients use `VITE_REVERB_*`.
Event names are dot-prefixed via `broadcastAs()`. **Every payload carries `v: 1`.** Payloads are built from the same Data classes the REST API
returns (`#[TypeScript]`), so web, loader and the future mobile app share one contract.
**The widget opens no websocket until the visitor starts a chat** (availability is a cached REST call).

## Channels and authorisation

| Channel | Audience | Authorisation |
|---|---|---|
| `private-staff.{userId}` | one staff member | `auth` (web session or Sanctum) and `user.id === userId`. |
| `presence-staff` | roster of signed-in staff | active staff only; member info `{id, name, avatarUrl, status}`. |
| `private-conversation.{ulid}` | the visitor of that conversation + its assigned agent; admins may monitor | callback with guards `web, sanctum, visitor`. Staff: `is_admin` **or** assigned agent **or** currently in the offered set of a still-`queued` chat. Visitor: bearer token whose session is bound to this conversation. Visitor auth endpoint: `POST /api/v1/public/broadcasting/auth` (Bearer `vt_…`). |
| `private-admin` | admins only | `is_admin`. |
| `private-whatsapp-admin` | admins only (P6) | `is_admin`. Agents can **never** subscribe. |

Why per-agent offer channels (not per-category channels): the eligible set is computed at request time (presence, category, capacity), so there are no stale subscriptions after an agent edits categories.

## Events

| Event | Channel | Payload | Delivery |
|---|---|---|---|
| `chat.offered` | `staff.{id}` (each eligible agent) | `{v, conversation: ulid, category: {slug,label}\|null, visitor: {name\|null, verified: bool}, preview: string\|null, widget: {ulid,name}, wave: int, expiresAt: ISO}` | queued |
| `chat.taken` | `staff.{id}` (other offered agents) | `{v, conversation, by: {id, name}}` | queued |
| `chat.assigned` | `staff.{id}` | `{v, conversation}` (transfer / admin assignment) | queued |
| `conversation.updated` | `staff.{id}`, `admin` | `{v, conversation: ConversationStaff}` (list refresh; status/assignee/unseen changes) | queued |
| `unread.updated` | `staff.{id}` | `{v, conversation, unseen: int}` | queued |
| `queue.updated` | `staff.{id}`, `admin` | `{v, queued: int}` | queued |
| `session.revoked` | `staff.{id}` | `{v, reason: 'role_removed'\|'deactivated'\|'auth_revoked'}` | now |
| `presence.changed` | `presence-staff` | `{v, userId, status: 'online'\|'away'\|'offline'}` | queued |
| `chat.claimed` | `conversation.{ulid}` | `{v, agent: {name, avatarUrl\|null}, claimedAt}` | now |
| `message.created` | `conversation.{ulid}` | `{v, message: Message}` | **now** (`ShouldBroadcastNow`, latency) |
| `message.seen` | `conversation.{ulid}` | `{v, upToSeq: int, by: 'visitor'\|'agent', at}` | queued |
| `client-typing` (whisper) | `conversation.{ulid}` | `{actor: 'visitor'\|'agent', typing: bool}` — debounce 3 s, auto-expire 5 s | client event |
| `conversation.ended` | `conversation.{ulid}` | `{v, endedBy: 'visitor'\|'agent'\|'admin', ratingRequested: bool}` | queued |
| `conversation.closed` | `conversation.{ulid}` | `{v, reason: 'rated'\|'skipped'\|'idle'\|'timeout'\|'system'}` | queued |
| `conversation.transferred` | `conversation.{ulid}` | `{v}` (visitor sees "connecting you to another agent…") | queued |
| `offline-ticket.created` | `admin` | `{v, conversation: ConversationStaff}` | queued |
| `conversation.rated` | `admin` | `{v, conversation, score: 1..5}` | queued |

Visitor-facing payloads never contain integer ids, agent ids, emails of staff or internal notes (`Message.sender` for agents is `{type:'agent', name, avatarUrl}`).

## Payload shapes

```ts
type Message = {
  ulid: string; seq: number; conversation: string;
  sender: { type: 'visitor' | 'agent' | 'system'; name: string | null; avatarUrl: string | null; id?: number /* staff-facing only */ };
  type: 'text' | 'image' | 'system';
  body: string | null;
  attachments: { ulid: string; mime: string; size: number; width: number | null; height: number | null; url: string; thumbUrl: string | null }[]; // url = short-lived signed URL
  clientMsgId: string | null; createdAt: string; deliveredAt: string | null; seenAt: string | null;
};
type ConversationPublic = {
  ulid: string; ticketNo: string; status: 'queued' | 'active' | 'ended' | 'closed' | 'missed';
  type: 'live' | 'offline'; category: { slug: string; label: string } | null;
  agent: { name: string; avatarUrl: string | null } | null;
  createdAt: string; endedAt: string | null; ratingRequested: boolean; lastSeq: number;
};
type ConversationStaff = ConversationPublic & {
  visitor: { ulid: string; name: string | null; email: string | null; phone: string | null; verified: boolean; meta: object };
  widget: { ulid: string; name: string }; assignedAgent: { id: number; name: string } | null;
  unseenByAgent: number; claimedAt: string | null; lastMessageAt: string | null; lastMessagePreview: string | null;
};
```

## Atomic first-accept (the only way a chat becomes `active`)

```sql
UPDATE conversations
   SET status='active', assigned_agent_id=:agent, claimed_at=NOW(6), claim_version=claim_version+1, idle_expires_at=:idle
 WHERE id=:id AND status='queued' AND assigned_agent_id IS NULL;
```
Affected rows `1` = winner (same transaction writes the `conversation_events` row + the "agent joined" system message; events dispatch after commit).
`0` = `409 { error: { code: 'already_claimed', details: { by: 'Name' } } }`. A Redis `SET claim:{id} NX EX 10` may reduce contention but **the SQL is the source of truth**.
Losers get `chat.taken` + a silent web-push with the same `tag` that dismisses the OS notification.

## Sync and reconnect

Clients track `lastSeq` per conversation. On Echo `connected` (after a drop), `visibilitychange -> visible`, or a detected gap (`seq > last+1`),
call `GET …/messages?after_seq=N` and merge idempotently by `ulid`/`seq`. Dashboard lists refetch with `updated_after` and rely on server unseen counters.
Receipts: clients `POST …/receipts {delivered_upto, seen_upto}` (debounced/batched); the server broadcasts `message.seen`.

## Timers (scheduled jobs)

- `idle_expires_at = last_activity_at + idle_timeout` (default 120 min, per widget); refreshed by messages from either side only (typing/presence do not count).
  `chat:close-idle` runs every minute in chunks of 500 and uses a guarded `UPDATE … WHERE status='active' AND idle_expires_at < NOW()`; result `closed` with reason `idle` (no rating prompt).
- `ExpireQueuedConversation` (delayed job at `queue_timeout_seconds`, default 90) marks a still-`queued` live chat `missed` and offers the offline form.
- `ended` conversations never rated close after `chat.rating_window_minutes` (default 10).
