# Realtime

> Status: design. **Nothing in this document is implemented as of P3**: Reverb and Echo are installed and the kit's default `App.Models.User.{id}` channel exists, but there are no chat channels, events, claim or presence yet (P4: chat, channels, claim, sync; P5: presence). The widget already follows the "no websocket until a chat starts" rule because its panel is a stub. Scaling numbers are TBD until the P7 load test. Event payloads: [contracts/realtime-events.md](contracts/realtime-events.md).

Laravel **Reverb** 1.12 (Pusher protocol, self-hosted) with `laravel-echo` / `pusher-js` on the clients and Redis-backed scaling. The **widget opens no websocket until the visitor starts a chat.**

## Channels

| Channel | Who | Carries |
|---|---|---|
| `private-staff.{userId}` | that agent/admin | chat offers, `chat.taken`, unread counters, `session.revoked` |
| `presence-staff` | all staff | roster / who is online |
| `private-conversation.{ulid}` | visitor + assigned agent; admin may monitor | messages, receipts, typing whispers, claimed/ended |
| `private-admin` | admins | admin-level events |
| `private-whatsapp-admin` | admins only | WhatsApp inbox updates; agents can **never** subscribe |

Offers use **per-agent** channels, not per-category, because the eligible set is computed at request time. Visitor channel auth uses the bearer visitor token at `/api/v1/public/broadcasting/auth`.

Only `chat.taken` is a fixed event name in the plan; other event names and payloads are defined in `docs/contracts/*`.

## Events (conceptual)

| Event | Channel | Purpose |
|---|---|---|
| offer | `private-staff.{userId}` | New request for an eligible agent (+ web push) |
| `chat.taken` | `private-staff.{userId}` | Another agent won; dismiss offer and OS notification (silent push) |
| claimed | `private-conversation.{ulid}` | Agent accepted; chat is active |
| message / receipts / typing | `private-conversation.{ulid}` | Chat traffic (typing via whispers) |
| ended | `private-conversation.{ulid}` | Either side ended; rating prompt |
| `session.revoked` | `private-staff.{userId}` | Auth session invalidated |

Domain events use `ShouldDispatchAfterCommit`; **messages use `ShouldBroadcastNow`** for latency. Receipts are batched.

## Atomic first-accept

Offers go to **all** eligible online agents; the first Accept wins:

```sql
UPDATE conversations
SET status = 'active', assigned_agent_id = :agent  -- ...other columns
WHERE id = :id AND status = 'queued' AND assigned_agent_id IS NULL;
```

One affected row = winner. Zero = `409 already_claimed`. A Redis `SET NX` is only a contention fast path; the SQL is the source of truth. Losers receive `chat.taken` plus a silent push that dismisses the OS notification. CI has a MySQL race test: N parallel claims, exactly one winner.

## Sequence, sync, reconnect

- Each conversation has a monotonic `seq` (unique `(conversation, seq)`); sends are idempotent via `client_msg_id` (unique `(conversation, client_msg_id)`).
- Clients track `lastSeq` and call `GET .../messages?after_seq=N` after reconnect, tab visibility change or a detected gap, so no duplicates and no holes.

## Routing and timers

Online agents are offered first, `away` agents after **20 s**, queue timeout **90 s** (per widget `queue_timeout_seconds`) then the request becomes an **offline ticket** (answered by email in v1). "Online" means presence `online` or `away`; optional per-widget `wake_offline_via_push` also counts push-subscribed offline agents (default off).

Idle rule: a chat auto-closes after N minutes without a message from either side; N is per widget (`idle_timeout_minutes`, default **120**). The idle sweep runs every minute with guarded updates. Presence: Redis ZSET as source of truth plus DB mirror, 30 s heartbeat, auto-away, sweep job.

## Conversation state machine

| From | To | Trigger |
|---|---|---|
| queued | active | agent claims (atomic) |
| queued | missed | queue timeout |
| queued | closed | visitor cancels |
| missed | offline ticket | offline form submitted (`type=offline`) |
| active | ended | either side ends (rating prompt) |
| active | closed | idle expiry (skips rating) |
| active | queued | transfer, or agent deactivated |
| ended | closed | rated, skipped, or window elapsed |

## Scaling notes

- Redis scaling for multiple Reverb instances; install `ext-uv`; raise the `nofile` ulimit for the Reverb container.
- No socket until a chat starts keeps idle visitors off Reverb.
- k6 test of about 1k concurrent sockets is planned in P7; results go to [runbook.md](runbook.md).
- See [architecture.md](architecture.md) for the end-to-end flow.
