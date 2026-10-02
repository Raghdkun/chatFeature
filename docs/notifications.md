# Notifications (web push)

> Status: implemented in P5, track 5B. Decisions P5-D4 to P5-D9 are in [contracts/presence-notifications-p5.md](contracts/presence-notifications-p5.md); the endpoints are in [rest-api.md](rest-api.md#notifications-api-p5). The realtime events the dashboard hears while it is open are in [realtime.md](realtime.md); push is for the moments it is not looking.

An agent who has closed the dashboard (or minimised the browser, or locked the phone) still hears about a new chat request: the server sends a **web push** to the browsers they enabled notifications in, the browser's **service worker** shows it, and a click brings the right chat to the front. An agent who IS looking at the inbox gets the in-page toast and sound instead, never both.

## What gets pushed, and to whom

| Event (domain event) | Push | Who |
|---|---|---|
| A routing wave offered a chat (`ChatOffered`) | `offer`: title "New chat request", body the topic and, with previews on, the visitor's first words (at most 120 characters). Tag `offer-{conversation ulid}`, TTL = the offer's remaining time, urgency `high`, stays until clicked | Each offered agent who allows offer pushes, is outside their quiet hours, has a registered browser and is **not looking at the dashboard** (below). The offer must still be open and the chat still waiting when the job runs |
| A visitor wrote in an active chat (`MessageCreated`, visitor only) | `message`: title "New message from {name}", body the message. Tag `chat-{ulid}`, renotify, TTL 15 minutes. At most one per chat and agent every `push.message_throttle_seconds` (8 s) | The agent the chat is assigned to, under the same conditions, with `push_messages` |
| Somebody took the chat, the visitor cancelled, the queue expired (`ChatTaken`, `ConversationClaimed`, `ConversationClosed` cancelled, `ConversationMissed`) | silent `dismiss` of `offer-{ulid}`: the notification disappears on every device | Only the users who were pushed that offer (a marker in the cache), the winner's other devices included |
| The agent read the chat, it ended, it was transferred away (`MessagesSeen` by the agent, `ConversationEnded`, `ConversationClosed`, `ConversationTransferred`) | silent `dismiss` of `chat-{ulid}` | The agent who was pushed a message of it |

Offline tickets are not pushed (they show in the offline-ticket list and as a toast); WhatsApp chats never are (admin-only, P6).

**Looking at the dashboard.** The listeners ask `App\Domain\Notifications\Contracts\DashboardVisibility::isViewingDashboard($userId, 60)`. The default implementation answers from the presence heartbeat the dashboard already sends (a heartbeat of an `online` / `away` agent younger than 60 s counts as looking); the presence context (5A) binds an implementation that reads the heartbeat's `visible` flag, so a hidden tab no longer counts. A tab that is open but in the background shows the OS notification itself (the page's own `Notification`, same tag as the push, so the browser replaces rather than doubles; for a visitor message it is built when the conversation update that carries the new words arrives, at most 400 ms after the unread counter, so it never shows the previous message's text).

**Quiet hours** (per member, `notification_settings.quiet_hours`): `{ enabled, start, end, timezone }`, wall-clock `HH:MM` in an IANA zone, `start` after `end` is an overnight window (22:00-07:00), the end is exclusive. They silence pushes and the page's own OS notifications; the toast and sound follow the sound setting. The same rule is implemented in PHP (`QuietHours`) and TypeScript (`lib/notifications/quiet-hours.ts`) with the same test matrix.

## The pieces

| Piece | Where |
|---|---|
| Tables `push_subscriptions` (keys encrypted at rest), `notification_settings`, `device_tokens` (migration `2026_11_20_000100`) | `app/Models/{PushSubscription,NotificationSetting,DeviceToken}.php` |
| `PushChannel` interface; `WebPushChannel` (VAPID, `minishlink/web-push`, Laravel's HTTP client so `Http::fake` covers it); `FcmChannel` (a stub: off, logs, no network) | `app/Domain/Notifications/{Contracts,Channels}` |
| Who is pushed: `PushEventSubscriber` (guards every handler), `PushOfferToAgents`, `PushVisitorMessage`, `DismissPushes`, `PushRecipients` | `app/Domain/Notifications/{Listeners,Actions,Services}` |
| Sending: `PushDispatcher` -> queued `SendPushToUser` (one job per recipient; a retry is a new job for only the failed devices) | `app/Domain/Notifications/{Services,Jobs}` |
| Config (VAPID, timeouts, windows, rate limits) | `config/push.php` |
| Endpoints, settings page, manifest | `routes/api/management/notifications.php`, `routes/web/notifications.php` |
| Service worker (plain JavaScript, no build step, no caching, no fetch handler) | `public/sw.js` |
| Client: controller (permission flow, subscribe, resubscribe on key change), host, dialog, settings page | `resources/js/lib/notifications`, `resources/js/components/notifications`, `resources/js/pages/settings/notifications.tsx` |
| The page's own OS notifications (same tag as the push, quiet hours, Android fallback through the worker) | `resources/js/lib/realtime/staff/os-notification.ts` |

## Setup

1. **VAPID keys.** `php artisan chat:bootstrap-secrets` writes `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` to `.env` (the Docker entrypoint does it). Without both, push is **off**: the `push` shared prop is `null`, the first-login dialog never opens, registering answers `503 push_unavailable`, the listeners do nothing and the dashboard keeps its toast, sound and title badge. Do not rotate the keys casually: every browser subscription is bound to the public key. After a rotation each browser re-subscribes the next time the dashboard opens (the client compares the key of its subscription with the server's, subscribes again and removes the old row).
2. `VAPID_SUBJECT` (`mailto:` or an https URL; default the app URL) identifies the sender to the push services. Apple's service wants a real `mailto:` or https URL.
3. **A queue worker** (`php artisan queue:work`, or `QUEUE_CONNECTION=sync` for a small install). Push jobs are queued; `PUSH_QUEUE` names a queue for them (default: the default queue). The scheduler is not needed for push.
4. **https.** Service workers and push need a secure context (localhost counts). Behind Caddy set `TRUSTED_PROXIES`.
5. Optional: `PUSH_FCM_ENABLED=true` only turns on the FCM stub's logging; nothing is sent over the network.

The administrator's switch for message text in pushes is the setting `notifications.push_include_preview` (default on; `settings()->set(...)` until an admin screen exists): off, no push carries anything a visitor typed, not even their name ("New chat request" / "New message" and the topic). Every member can also turn their own previews off in Settings > Notifications.

## The first-login flow (P5-D7)

Never on page load. After a staff member's first sign-in (no `prompt_state` yet) the page shows an **in-app explainer dialog**; only its **"Turn on notifications"** button calls `Notification.requestPermission()`, then registers `/sw.js`, subscribes with `userVisibleOnly` and the server's key and POSTs the subscription. **"Not now"** (also Escape and the close button) snoozes for 7 days (`push.snooze_days`, the server computes the deadline); a refusal is recorded as `denied` and shown on Settings > Notifications with instructions to unblock the site; the dialog never opens on that page itself. A browser that cannot do push (no service worker / Push API, http, an iPhone Safari tab) never sees the dialog: it keeps toast + sound + title badge, and the settings page says why.

When the permission is already granted the page re-checks the subscription on every load (it registers the browser again, which refreshes the session it belongs to). "Turn off for this browser" unsubscribes it and remembers the choice per user on that device, so the next load does not quietly subscribe again.

**iOS.** Safari on iPhone and iPad only delivers web push to a web app **added to the Home Screen** (iOS 16.4+): open the site, Share, Add to Home Screen, then open it from the icon and turn notifications on. The manifest (`GET /manifest.webmanifest`, generated from the app name setting, icons in `public/icons`) is what makes the install work. Safari also shows a notification for every push (it drops a subscription that keeps receiving silent ones), which is why a `dismiss` shows a transient notification and takes it down at once (`public/sw.js`). Chrome behaves the same way when a push does not end in a visible notification.

## Privacy and security

- **Payload.** Encrypted end to end by the push protocol (RFC 8291), small, and only: `title`, `body`, `renotify`, `requireInteraction`, `data: { url, tag, type }`. The `url` is a same-origin path (`/inbox/{ulid}`, the worker refuses anything else), the tag/ulid are public ids. Never an integer id, an e-mail address or a phone number. With previews off: no visitor text at all.
- **At rest.** The browser's `p256dh` and `auth` keys are encrypted (the application key), the endpoint is a secret URL and is never returned by the API (only its host and a hash). FCM tokens are encrypted too.
- **Request forgery.** The server posts to a URL the browser supplied, so an endpoint must be https and resolve only to public addresses (`PushEndpointGuard` / `OutboundUrlGuard`, checked when it is stored AND before every send); redirects are never followed; log lines never contain an endpoint.
- **Ownership.** Every endpoint is the caller's own rows (404 for anyone else's); a browser another member signs in to moves to them; **signing out deletes the subscriptions that web session registered** (`ForgetSessionPushSubscriptions`, on the `Logout` event), so a shared computer stops showing the previous person's chats. A session that simply expires leaves its browser subscribed until somebody signs in there.
- **Rate limits.** Registering 20 a minute and user, the test push 3 a minute and user (it is a real push), every call also under `staff-api`.
- **Failure isolation.** Every listener runs inside a guard and the job never throws: a push service that is down, a cache or queue outage or a bug in the push code never fails the request that caused the event (`PushFailureIsolationTest`). Retries are bounded (3 tries: 5 s, 30 s) and only for the devices that failed; a 404/410 deletes the subscription; an offer is never pushed (or retried) after its TTL.

## Troubleshooting

| Symptom | Check |
|---|---|
| No dialog, no "Turn on" button, the page says push is not set up | `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `.env` (`chat:bootstrap-secrets`), `php artisan config:clear` if the config is cached |
| "Notifications are blocked for this site" | The browser's site settings: set Notifications to Allow, reload, turn them on again |
| Dialog never appears on an iPhone | Add the app to the Home Screen and open it from there (the settings page says so) |
| "Send a test notification" says the push service did not accept it | `storage/logs/laravel.log` for `push.web.refused` (status 403/401 = VAPID subject or keys, 400 = bad payload) or `push.web.failed` (network). Is `VAPID_SUBJECT` a real `mailto:`/https URL? Did the VAPID keys change since the browser subscribed? (turn notifications off and on again in that browser) |
| Test works, real offers do not arrive | Is a queue worker running? Is the agent's tab open and visible (then they get the toast, not a push)? Quiet hours? "New chat requests" on? `php artisan queue:failed` |
| The notification shows up twice | The page and the push use the same tag (`offer-{ulid}`, `chat-{ulid}`); a different tag means a stale service worker: Application > Service Workers > Unregister, reload |
| An old notification stays after the chat was taken | The dismiss only reaches devices that were pushed the offer (cache marker, 1 hour); closed browsers get it when they next connect to the push service |
| Everything works locally, nothing in production | https (a secure context), `TRUSTED_PROXIES`, outbound HTTPS from the server to the push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) |

## Known limits

- A dismiss that arrives before the offer it dismisses (two workers, the offer's request still in flight) leaves the offer notification until it is clicked; the TTL only covers devices that were offline.
- The real push services are never reached by the automated tests (`Http::fake`); the e2e run drives `public/sw.js` with the DevTools Protocol (`ServiceWorker.deliverPushMessage`). Delivery to a real browser and the iOS install flow were not exercised here.
- There is no admin screen yet for `notifications.push_include_preview`.
- Offline tickets, assignments by an admin and WhatsApp messages are not pushed.
