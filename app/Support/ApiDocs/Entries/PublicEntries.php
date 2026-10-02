<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Chat\AttachmentData;
use App\Data\Chat\ConversationPublicData;
use App\Data\Chat\MessageData;
use App\Data\Chat\RatingData;
use App\Data\Chat\SessionData;
use App\Data\WhatsApp\HandoffData;
use App\Domain\Widgets\Data\AvailabilityData;
use App\Domain\Widgets\Data\ResolvedBootConfigData;
use App\Support\ApiDocs\Doc;

/** The visitor side: config, session, chat, messages, rating, offline tickets, WhatsApp hand-off, realtime auth and widget delivery. */
final class PublicEntries implements EntryList
{
    public static function docs(): array
    {
        return [
            Doc::route('api.public.widgets.config')
                ->in('Widget config')
                ->title('Get the widget config')
                ->about("The PUBLISHED config of the widget with its greetings, enabled categories, availability and the `api` block (drafts never leave the dashboard). Cacheable: `ETag` (a hash of the body without `generatedAt`; `If-None-Match` answers `304`), `Cache-Control: public, max-age=60, stale-while-revalidate=300`, `Vary: Origin`.\n\n`?locale=` is optional and ignored when it is not a locale tag; matching is exact, language, a variant of the language, else the widget default (`data.locale` says which). Only the default and the resolved text block are returned (all blocks without the parameter).\n\n**CORS.** The response carries `Access-Control-Allow-Origin: <origin>` only when the request `Origin` is on the widget's domain list (or is this installation's own origin); `OPTIONS` preflights are answered with `204` for allowed origins (`Allow-Methods: GET, OPTIONS`). Requests without an `Origin` (servers, native apps) need the widget's `allow_non_browser_clients` switch.")
                ->item(ResolvedBootConfigData::class, 200, 'The resolved boot config.')
                ->raw(304, 'application/json', '', 'Not modified: the client already has this version (`If-None-Match`).')
                ->errors(['widget_not_found', 'origin_not_allowed']),

            Doc::route('api.public.widgets.availability')
                ->in('Widget config')
                ->title('Get the widget availability')
                ->about("Whether the widget can take chats right now: opening hours of the published config (in the widget's timezone) combined with agent presence. `online` counts only agents the widget's routing waves can offer a chat to, so it never promises a chat that `POST /public/conversations` then refuses with `no_agents`. Cached for 8 seconds on the server and `max-age=5` for the client; `ETag` / `304` as for the config. `whatsapp.enabled` is true only when a connected WhatsApp session is linked and enabled. Same origin rules as the config.")
                ->item(AvailabilityData::class)
                ->raw(304, 'application/json', '', 'Not modified (`If-None-Match`).')
                ->errors(['widget_not_found', 'origin_not_allowed']),

            Doc::route('api.public.sessions.store')
                ->in('Sessions')
                ->title('Create a visitor session')
                ->about("Creates the visitor session and returns its bearer token `vt_...` (**shown once**; only the sha256 is stored) plus where to open the websocket and the limits to check client-side. All input is optional: an anonymous visitor sends nothing, a signed identity (`identity_token`) makes the visitor `verified` and keyed by its `sub` (one visitor across browsers; the claims are authoritative and the pre-chat form never overwrites them). A token that does not verify is refused with `422` and `details.identity_token`: it is never downgraded to anonymous.\n\nThis is the one public call that goes through the widget gate: unknown or disabled key `404 widget_not_found`, a browser `Origin` that is not on the domain list `403 origin_not_allowed` (no CORS headers), and a request without `Origin` only when the widget allows non-browser clients. A browser on another origin cannot call it: the cross-origin preflight is not answered (see the integration guide), so third-party web clients proxy through their backend and native apps call it directly.\n\n**Rotation.** Calling it again with the previous token in `Authorization: Bearer` rotates it: same visitor, a new token, and the previous token keeps working for 60 more seconds (a second tab may be mid-request) and is then `401 session_revoked`. A still-open live chat moves to the new session and is returned in `conversation`.\n\nThe answer is `Cache-Control: no-store`.")
                ->created(SessionData::class, 'The new session. Store `visitorToken`; send it as `Authorization: Bearer` from now on.')
                ->errors(['validation_failed' => '`details.identity_token` when a signed identity does not verify, or a field is invalid.']),

            Doc::route('api.public.sessions.destroy')
                ->in('Sessions')
                ->title('End the visit')
                ->about('Revokes **every** active session of the visitor (a leftover token must not outlive an explicit sign-out). A chat still `queued` is cancelled with it; an active one stays (the idle timer closes it). The revocation always happens, even when an agent claims the queued chat a moment earlier.')
                ->noContent(204, 'Revoked.'),

            Doc::route('api.public.conversation.show')
                ->in('Conversation')
                ->title('Get the visitor\'s chat')
                ->about("This session's latest LIVE conversation in **any** status (so the outcome of a `missed` or `closed` chat is readable when no realtime event arrived), or `data: null`. Never a list and never offline tickets: visitors do not see history.")
                ->item(ConversationPublicData::class, 200, 'The conversation, or `{ "data": null }` when the session has none.', false, nullable: true),

            Doc::route('api.public.conversations.store')
                ->in('Conversation')
                ->title('Start a chat')
                ->about("Creates a live chat in status `queued`; an optional `message` becomes message 1, and the chat is offered to every reachable agent of the category (first accept wins). The widget's pre-chat rules are enforced here: a required, enabled field must be present unless the visitor already has it, a disabled field is ignored, and a consent text needs `consent: true`.\n\n**Anti-automation.** Starting a chat fans an offer out to every reachable agent, so besides the per-minute limits there are two guards that answer `429 rate_limited` with `Retry-After` and `details.retry_after`: after a visitor cancels a queued chat they cannot start another for 10 seconds, and at most 3 live chats wait for an agent at once from one client network on one widget.")
                ->created(ConversationPublicData::class, 'The chat is queued.', false)
                ->errors([
                    'no_agents' => 'Outside the opening hours, or nobody reachable serves the topic: show the offline form.',
                    'conversation_exists',
                    'validation_failed' => 'The category is unknown, inactive or not on this widget (`details.category`), or a pre-chat rule failed.',
                ]),

            Doc::route('api.public.conversations.end')
                ->in('Conversation')
                ->title('End the chat')
                ->about('The visitor ends an active chat. `ratingRequested` becomes `true` and the rating window opens; on a widget whose `features.rating` is off the chat goes straight to `closed` (reason `skipped`).')
                ->item(ConversationPublicData::class, 200, '', false)
                ->errors(['conversation_not_active' => 'Also for a queued chat: cancel it instead.', 'feature_disabled' => 'The widget switched `endChatByVisitor` off.']),

            Doc::route('api.public.conversations.cancel')
                ->in('Conversation')
                ->title('Cancel a waiting chat')
                ->about('The visitor leaves a `queued` chat: it becomes `closed` (reason `cancelled`).')
                ->item(ConversationPublicData::class, 200, '', false)
                ->errors(['conversation_not_queued' => 'An agent was first.']),

            Doc::route('api.public.messages.index')
                ->in('Messages & attachments')
                ->title('List messages')
                ->about('Messages after `after_seq`, ascending by `seq`, at most `limit`; `meta.next_cursor` is the `after_seq` of the next page, `null` at the end. Visitor-safe: agents appear as `{ type, name, avatarUrl }`, no ids or e-mail addresses. This is also the polling fallback when no websocket is available, and the gap sync after any reconnect: pass the highest `seq` you hold.')
                ->paged(MessageData::class, 'A page of messages.', false),

            Doc::route('api.public.messages.store')
                ->in('Messages & attachments')
                ->title('Send a message')
                ->about('Only an `active` live chat takes messages. Send a `client_msg_id` (a ULID you make up) so a retry is safe: a repeat answers `200` with the original message, also after the chat ended.')
                ->created(MessageData::class, 'The message was stored.', false)
                ->item(MessageData::class, 200, 'A repeat of a `client_msg_id` already stored: the original message.', false)
                ->errors(['conversation_not_active', 'validation_failed' => 'Neither `body` nor `attachments`, a body over the limit, more than 5 attachments, or an attachment that is not this conversation\'s upload.']),

            Doc::route('api.public.attachments.store')
                ->in('Messages & attachments')
                ->title('Upload an image')
                ->about('Multipart upload of one image, then reference its `ulid` in the next message. Judged by content (`finfo`), never by name or declared type; SVG, HTML, PDF, scripts and polyglots are refused. The image is decoded and encoded again, so EXIF, XMP, comments and anything hidden in them do not survive; a 320 px thumbnail is made. An animated GIF is refused. Unreferenced uploads are deleted after 24 hours.')
                ->created(AttachmentData::class)
                ->errors([
                    'feature_disabled' => 'The widget switched attachments off.',
                    'conversation_not_active',
                    'attachment_quota_exceeded',
                    'validation_failed' => 'Not an allowed image, an animated GIF, over the size or pixel limit, or 10 uploads already wait. The message is under `details.file`.',
                ]),

            Doc::route('public.attachments.show')
                ->in('Messages & attachments')
                ->title('Download an image')
                ->about("The target of the signed `url` / `thumbUrl` in message payloads. Do not send an `Authorization` header and never log the URL: its signature is the credential (valid `chat.attachment_url_ttl_minutes`, default 240, for exactly one attachment; `thumb=1` is part of the signature). The image is streamed from the private disk with its stored content type, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, under a neutral file name.")
                ->raw(200, 'image/jpeg', '<<binary>>The image bytes.', 'The image.', ['X-Content-Type-Options' => 'nosniff', 'Content-Security-Policy' => "default-src 'none'; sandbox", 'Cache-Control' => 'private, max-age=600'])
                ->errors(['forbidden' => 'The signature is missing, altered, expired or belongs to another URL (or another `thumb` value).']),

            Doc::route('api.public.receipts.store')
                ->in('Messages & attachments')
                ->title('Report delivery and read receipts')
                ->about('Stamps `deliveredAt` / `seenAt` on the agent\'s messages up to the given numbers (reading implies delivery) and announces `message.delivered` / `message.seen` on the conversation channel; repeating a receipt changes and announces nothing. Batch them (the widget sends about 300 ms after the messages are on screen).')
                ->noContent(204, 'Recorded.'),

            Doc::route('api.public.typing.store')
                ->in('Messages & attachments')
                ->title('Send a typing indicator')
                ->about('The REST fallback of the `client-typing` websocket whisper: validated and authorised, then published as the realtime `typing` event. Nothing is stored and it never counts as activity for the idle timer.')
                ->noContent(204, 'Published.')
                ->errors(['conversation_not_active']),

            Doc::route('api.public.rating.store')
                ->in('Rating')
                ->title('Rate the chat')
                ->about('One rating per conversation. The chat becomes `closed` (reason `rated`).')
                ->created(RatingData::class)
                ->errors(['conversation_not_ended', 'already_rated', 'rating_window_closed']),

            Doc::route('api.public.rating.skip')
                ->in('Rating')
                ->title('Skip the rating')
                ->about('Accepted for every `ended` chat inside its rating window, whatever the widget\'s rating flag says. The chat becomes `closed` (reason `skipped`).')
                ->item(ConversationPublicData::class, 200, '', false)
                ->errors(['conversation_not_ended', 'rating_window_closed']),

            Doc::route('api.public.offline-tickets.store')
                ->in('Offline tickets')
                ->title('Create an offline ticket')
                ->about('The offline form: a separate row (`type: offline`, `status: queued`, no queue timeout) that staff answer by e-mail. Offered after `no_agents` or a `missed` chat; `missed_conversation` records which. There is no conversation to give an id for: the `409 no_agents` path creates none.')
                ->created(ConversationPublicData::class, 'The ticket.', false)
                ->errors(['feature_disabled' => 'The widget switched the offline form off.', 'validation_failed' => 'A field is invalid.']),

            Doc::route('api.public.whatsapp.handoff')
                ->in('WhatsApp hand-off')
                ->title('Hand the visitor over to WhatsApp')
                ->about("Creates a one-time code and a `https://wa.me/<number>?text=...` link that opens WhatsApp with it typed in; when the visitor sends it, the WhatsApp chat is linked to their widget visitor. A visitor who asks again while their code for the same topic is still live gets it back with `200` (one live ticket per visitor and topic). The code has 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` and lives `whatsapp.handoff_ttl_minutes`.\n\n`{key}` must be the token's own widget (anything else is the same `404 widget_not_found` an unknown key gets). Besides the per-visitor limits the number of LIVE codes is capped per client network and widget (30) and per widget (500); `Retry-After` is when the first of them expires.")
                ->created(HandoffData::class, 'A new code.', false)
                ->item(HandoffData::class, 200, 'The visitor\'s live code for this topic.', false)
                ->errors(['feature_disabled' => 'The widget\'s `features.whatsapp` or the global switch is off.', 'whatsapp_unavailable', 'validation_failed' => '`details.category`.']),

            Doc::route('api.public.broadcasting.auth')
                ->in('Realtime')
                ->title('Authorise a visitor channel')
                ->about("The Pusher channel authorisation of a VISITOR, exactly what `pusher-js` posts (form or JSON fields `socket_id` and `channel_name`) with the visitor bearer in `authEndpoint` headers. It signs **only** `private-conversation.{ulid}` of the conversation the session is bound to (the ulid spelled lower case, as events are published); anything else is `403 channel_forbidden`, never `404`, because a Pusher client treats any non-200 as a refusal. The signature comes from the configured broadcaster (the Reverb app secret never leaves the server); the answer is `Cache-Control: no-store` and sets no cookie.\n\nConnect to the host, port and scheme of `ws` from the session answer with the app `key`. `503 realtime_unavailable` means Reverb is not configured: stay on REST polling.")
                ->param('socket_id', ['description' => 'The socket id Reverb gave the connection (`<digits>.<digits>`).', 'example' => '123456.7890123'])
                ->param('channel_name', ['description' => 'Must be `private-conversation.` + the ulid of the session\'s conversation.', 'example' => 'private-conversation.01j9z3q8x7m5n2k4p6r8t0v1w2'])
                ->data(['auth' => 'f1a2b3c4d5e6f7a8b9c0:3b1f0c9e5a7d2e4f6a8b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7', 'channel_data' => '{\"user_id\":\"v_3f9c1a7e5b2d4086a1c7e9f3\"}'], 200, 'The signed channel authorisation: `<app key>:<signature>`, and the signed `channel_data` the Pusher client must pass on as is.', ['auth' => ['description' => '`<app key>:<hmac signature>`, handed to the Pusher client.'], 'channel_data' => ['description' => 'A JSON string naming the opaque principal tag this subscription is signed with (it lets the server close the visitor\'s sockets when the session ends). Not an identity: do not parse or display it.']], false)
                ->errors(['channel_forbidden', 'realtime_unavailable', 'validation_failed' => 'A malformed `socket_id` or `channel_name`.']),

            Doc::route('embed.script')
                ->in('Widget delivery')
                ->title('Widget script')
                ->about("`GET /w/{key}.js`: the loader bundle with the boot config inlined, for a `<script async src=...>` tag. Not under `/api`, no session and no cookies; `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=300`, `X-Content-Type-Options: nosniff`, `Vary: Referer`. A script tag cannot be CORS-gated, so this is the one place that looks at the `Referer`: an origin that is not on the widget's domain list gets `403`, no `Referer` is served. Errors are plain text or HTML, not the JSON envelope.")
                ->raw(200, 'application/javascript; charset=utf-8', "/* PNE Chat loader + boot config */\n", 'The script.', ['X-Content-Type-Options' => 'nosniff', 'Cache-Control' => 'public, max-age=60, stale-while-revalidate=300']),

            Doc::route('embed.loader')
                ->in('Widget delivery')
                ->title('Generic loader script')
                ->about('`GET /widget/v1/loader.js`: one script for every widget; it reads `data-widget-key` from its own tag and fetches the config from the public API. When `public/widget/v1/loader.js` exists the web server serves that file itself.')
                ->raw(200, 'application/javascript; charset=utf-8', "/* PNE Chat loader */\n", 'The script.', ['X-Content-Type-Options' => 'nosniff', 'Cache-Control' => 'public, max-age=60, stale-while-revalidate=300']),

            Doc::route('embed.frame')
                ->in('Widget delivery')
                ->title('Chat panel page (iframe)')
                ->about("`GET /embed/{key}[?mode=inline]`: the Blade shell of the React chat panel, to be put in an iframe. `Content-Security-Policy: frame-ancestors <widget domains>` (`'none'` when the list is empty), no cookies. `?preview=1` is for signed-in administrators only (the builder preview).")
                ->raw(200, 'text/html; charset=utf-8', "<!doctype html>\n<html>...</html>\n", 'The panel page.', ['X-Content-Type-Options' => 'nosniff', 'Referrer-Policy' => 'strict-origin-when-cross-origin']),

            Doc::route('embed.hosted')
                ->in('Widget delivery')
                ->title('Hosted chat page')
                ->about("`GET /c/{key}`: the panel as a standalone page; it sends `frame-ancestors 'none'`.")
                ->raw(200, 'text/html; charset=utf-8', "<!doctype html>\n<html>...</html>\n", 'The page.'),
        ];
    }
}
