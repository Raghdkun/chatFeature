# Chat UI: embed panel (iframe) and agent inbox (P4)

> Status: contract v1 (written ahead of P4; may be refined before P4 fans out). Tracks: **4A** domain + REST, **4B** realtime, **4C** dashboard inbox,
> **4D** embed panel. Data shapes: [realtime-events.md](realtime-events.md) (`Message`, `ConversationPublic`, `ConversationStaff`), endpoints: [rest-shapes.md](rest-shapes.md).

## Embed panel (React, runs inside `/embed/{key}`; entry `resources/js/embed/main.tsx`)

State machine (single source of truth in a reducer; every transition emits a `state` postMessage to the loader):

| State | Meaning | Next |
|---|---|---|
| `booting` | waiting for the host's `init` (handshake), loading translations | `idle` |
| `idle` | panel opened, no conversation | `prechat` (form enabled) / `category` / `offline` (availability says no agents) |
| `prechat` | name/email/phone per widget config (required/optional, consent) | `category` |
| `category` | topic picker (widget's enabled categories; skipped if exactly one) | `queued` (`POST /public/conversations`), `offline` on `409 no_agents` |
| `queued` | "Connecting you to an agent…", elapsed timer, cancel button; opens the websocket now | `active` (`chat.claimed`), `offline` (queue timeout / `missed`), `closed` (cancel) |
| `active` | live chat: message list, composer, attachments, typing, delivered/seen ticks, agent header, end-chat | `ended` |
| `ended` | closed by either side → rating screen (1–5 stars + optional comment, skippable) | `closed` |
| `offline` | offline form (name, email, message, category) → `POST /public/offline-tickets` → ticket created confirmation | `closed` |
| `closed` | thank-you + "Start a new chat" (clears the session; a new chat = new ticket) | `idle` |

Rules: visitors see **only the current session** (no history list); a refresh while `queued`/`active` resumes via `GET /public/conversation` + `GET …/messages?after_seq=0`.
Websocket opens only when entering `queued`/resuming; Echo (Pusher protocol, Reverb) authorises through `POST /api/v1/public/broadcasting/auth` with the visitor bearer token; channel `private-conversation.{ulid}`;
typing via whisper `client-typing` (debounce 3 s, expire 5 s); on reconnect/visibility/gap call `GET …/messages?after_seq=<lastSeq>` and merge idempotently by `ulid`/`seq`.
Messages are sent optimistically with a client `client_msg_id` (ULID), shown as `sending` → `sent` (server ack) → `delivered` → `seen`; failures show a retry affordance; attachments: image only, client-side type/size precheck (5 MB), thumbnail preview, progress, remove-before-send.
Visitor-facing text is plain text (no HTML/markdown execution; URLs auto-linked with `rel="noopener noreferrer nofollow"`).
Accessibility: `role="log"` + `aria-live="polite"` for new messages, labelled controls, focus management on open/close, reduced-motion safe, RTL-safe (logical CSS), works from 320px; below 480px the loader makes the iframe fullscreen (the panel adapts to `viewport` messages / `100dvh` / safe-area insets and keeps the composer above the iOS keyboard).
Sounds: per widget `features.sounds`; a short in-iframe notification sound on agent messages (Web Audio unlocked on first gesture). WhatsApp channel chooser slot (P6) is rendered only when `availability.whatsapp.enabled && features.whatsapp`.
Test ids: `chat-panel`, `chat-state[data-state]`, `prechat-form`, `category-option-{slug}`, `queued-timer`, `queued-cancel`, `message-list`, `message-{ulid}[data-status]`, `composer-input`, `composer-send`, `composer-attach`, `typing-indicator`, `end-chat`, `rating-stars`, `rating-submit`, `offline-form`, `new-chat`.

## Agent dashboard (Inertia + management REST)

| Route | Page | Props |
|---|---|---|
| `GET /inbox` (staff) | `inbox/index` | `{ queue: ConversationStaff[], mine: ConversationStaff[], presence: { status: 'online'\|'away'\|'offline' }, categories: CategoryData[] }` (agents: only chats offered to / assigned to them; admins: everything) |
| `GET /inbox/{ulid}` | `inbox/show` (same shell, conversation selected) | `{ conversation: ConversationStaff, messages: Message[] }` |
| `GET /history` (admin) | `history/index` | filters (status, category, widget, agent, type, q, from, to) → paged `ConversationStaff[]` |
| `GET /offline-tickets` (staff) | `offline-tickets/index` | `{ tickets: ConversationStaff[] }` (offline `queued`/`active`, claim + reply by email) |

Inbox layout: left column = **Queue** (pending offers with countdown, category, visitor preview, big **Accept** button; sound + toast + OS notification on arrival) and **My chats** (unseen badges, last message preview, sorted by last activity);
right = conversation (header: visitor name/email/page URL, category, ticket no., widget; message list with date separators, delivered/seen, image lightbox; composer with attach, canned replies slot, typing; actions: end chat, transfer (agent/category), copy transcript).
Mobile: list → detail drill-down with back navigation; accept button always reachable; the document title shows the unseen count; presence selector (online/away/offline) in the header.
Realtime: `private-staff.{userId}` (`chat.offered`, `chat.taken`, `chat.assigned`, `conversation.updated`, `unread.updated`, `session.revoked`), `private-conversation.{ulid}` for the open chat, `presence-staff` roster; all through `@laravel/echo-react` (`useEcho`).
**Accept** = `POST /conversations/{ulid}/claim`: `200` → open the chat; `409 already_claimed` → toast "Taken by {name}" and remove the offer.
Test ids: `inbox-queue`, `offer-{ulid}`, `offer-accept-{ulid}`, `inbox-mine`, `chat-row-{ulid}`, `chat-unseen-{ulid}`, `conversation-view`, `message-list`, `composer-input`, `composer-send`, `composer-attach`, `end-chat`, `transfer-chat`, `presence-select`.
