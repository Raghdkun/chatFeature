# WhatsApp via OpenWA

> Status: design, implemented in P6. Facts below come from the OpenWA source/docs; payload and media details must be confirmed against the real image in P6.

[OpenWA](https://www.open-wa.org) (repo `rmyndharis/OpenWA`, MIT) is a self-hosted WhatsApp gateway. It is **not** the old wa-automate project.

## Verified facts

| Topic | Fact |
|---|---|
| Image / port | `ghcr.io/rmyndharis/openwa:latest`, port **2785**, REST under `/api` |
| Auth | Header `X-API-Key` (roles viewer/operator/admin; key can be scoped by `allowedSessions` / `allowedChats`) |
| Sessions | `POST /api/sessions {name}`, `POST /api/sessions/{id}/start`, `GET /api/sessions/{id}/qr` |
| Send text | `POST /api/sessions/{id}/messages/send-text {chatId,text}` |
| Send media | `send-image` etc. use a flat DTO `{chatId,url\|base64,mimetype,filename,caption}` |
| Send result | `201` means *accepted, not delivered*; optional pacing can return `429 SEND_PACING_LIMITED` |
| Webhook register | `POST /api/sessions/{id}/webhooks {url,events[],secret,filters,retryCount}` |

### Webhook delivery

Body: `{event,timestamp,sessionId,idempotencyKey,deliveryId,data}`. Headers:

| Header | Meaning |
|---|---|
| `X-OpenWA-Signature` | `sha256=<hex>`, HMAC-SHA256 over the **raw body** with the webhook secret |
| `X-OpenWA-Event` | Event name |
| `X-OpenWA-Idempotency-Key` | **Dedupe on this**; delivery is at-least-once |
| `X-OpenWA-Delivery-Id` | Per-delivery id |
| `X-OpenWA-Retry-Count` | Retry counter |

`message.received` `data`: `id, from, to, body, type, timestamp` (epoch seconds), `isGroup, kind, contact{name,pushName}, media{...}`. The sender may be an `@lid`; set `RESOLVE_LID_TO_PHONE=true` to receive `senderPhone`. Media over 1 MiB is not inlined (`omitted:true`) and must be fetched through the media endpoint.

### Verifying the signature (Laravel)

```php
$raw      = $request->getContent();                       // raw body, not re-encoded JSON
$expected = 'sha256='.hash_hmac('sha256', $raw, $session->webhook_secret);
$given    = (string) $request->header('X-OpenWA-Signature', '');

abort_unless(hash_equals($expected, $given), 401);        // missing/tampered -> reject
```

Endpoint: `POST /webhooks/openwa/{session_ulid}`. Order: verify signature, dedupe on `X-OpenWA-Idempotency-Key` / delivery id (`wa_webhook_deliveries`), then process on the queue. Keep the raw JSON; parse tolerantly. The rejection status code is finalised in P6.

## SSRF gotcha

OpenWA rejects webhook URLs that resolve to private/loopback addresses at registration. Inside Docker Compose the app host is private, so set `SSRF_ALLOWED_HOSTS` on the OpenWA container to include the app's service host.

## Engines and ban risk

| Engine | Notes |
|---|---|
| `whatsapp-web.js` (default) | Lower ban risk, about 300-500 MB RAM per session |
| `baileys` | Lighter, higher ban risk |

Automation of a WhatsApp account can get the number banned. Guidance: use a **dedicated number**, reply only to chats the customer started, apply sending pacing and a daily cap, and show a UI warning. `baileys` is the lighter alternative, at higher ban risk.

## Hand-off flow

1. Widget offers "built-in chat" or "WhatsApp".
2. `POST /public/whatsapp/handoff` returns an **8-char ticket code** and `https://wa.me/<number>?text=Hi! My support code is K7M2QX`.
3. The visitor sends the first message; `ChatLinker` matches the code and attaches widget/visitor/category to the `wa_chat`.
4. Unlinked chats are still recorded; **groups are ignored by default**.
5. Admin replies from the inbox via `send-text`.

Tables: `whatsapp_sessions`, `wa_handoff_tickets`, `wa_chats`, `wa_messages`, `wa_webhook_deliveries`.

## Admin-only isolation

WhatsApp is never joined to `conversations`. History is visible only to admins in the WhatsApp Inbox. Every route, Inertia page, broadcast channel (`private-whatsapp-admin`) and search endpoint returns 403 or hides data for agents; this is covered by dedicated isolation tests (P6 exit criterion).

## Compose notes

- Run OpenWA on an internal network, image pinned by digest in production.
- Set `SSRF_ALLOWED_HOSTS`; optionally mount OpenWA's data volume read-only into the app so the wizard can detect the API key.
- Outbound limits: pacing, daily cap, inbound-initiated chats only.
- See [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md). Real-device round trip needs a phone to scan the QR (P6).
