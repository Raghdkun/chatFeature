# Full feature verification (real browser), 2026-10-05

> Status: written after the verification pass of 2026-10-05 on `integrate/phase-5` (post `v0.7.0`). It records what was driven, what failed, what was fixed and what is still open. The scripts and the roughly 1,000 screenshots were session scratch and are not in the repository; every fix below has a regression test, and the fixes were re-checked in Chrome.

## How it was done

- Six verifiers each drove **real Chrome** (Playwright, `channel: 'chrome'`, headless) through an area of the product on their **own isolated instance**: own MySQL database (`chatfeature_qa<N>`), own storage and install-state directory, own ports (85N0-85N3), `CSP_MODE=enforce`, `MAIL_MAILER=log`. No instance touched the development database or the dev servers. Instance 1 started uninstalled (the wizard), instance 6 had the OpenWA mock.
- Everything was done through the UI (sign-in, forms, the widget on a cross-origin customer page); `curl`, SQL and `artisan` only prepared data, aged rows, made requests a browser cannot (forged origins, cookie-less calls) and asserted what was stored. Each verifier read its screenshots, ran axe (WCAG A/AA) and tried 375 px, 320 px, dark mode and RTL.
- A finding is a **bug** only if reproduced with a script; severities: S1 data loss/security hole, S2 a core flow broken or an easy abuse, S3 wrong behaviour with a workaround, S4 polish.

## Results

| Group | Area | Checks | Pass | Partial | Fail | Blocked | Bugs (S2 / S3 / S4) |
|---|---|---|---|---|---|---|---|
| A | Install wizard (both modes), sign-in, account, 2FA, passkeys, roles, headers, native sign-in, mode 2 | 122 | 94 | 12 | 12 | 4 | 5 / 6 / 7 |
| B | Categories, agents, widgets, builder, preview, loader, JS API, signed identity, locale, a11y | 135 | 108 | 16 | 9 | 2 | 1 / 4 / 12 |
| C | The chat lifecycle: routing, messages, images, transfer, end, rating, offline tickets, history | 281 | 259 | 10 | 8 | 4 | 0 / 7 / 0 |
| D | Presence, notifications (real FCM push), dashboard, analytics, shell/PWA, settings, scheduler | 116 | 97 | 11 | 6 | 2 | 0 / 7 / 12 |
| E | Permissions, visitor isolation, CSP/headers, rate limits, XSS, uploads, privacy, realtime security, API, operations | 126 | 110 | 8 | 6 | 2 | 2 / 4 / 6 |
| F | WhatsApp with the OpenWA mock: sessions, QR, hand-off, webhooks, inbox, replies, isolation, retention | 122 | 112 | 6 | 3 | 1 | 0 / 4 / 8 |
| | **Total** | **902** | **780** | **63** | **44** | **15** | **8 / 32 / 45** |

Nothing was found that loses data or leaks one visitor's data to another. What held up without a change: visitor isolation (36 cross-visitor calls, all identical to "missing"), the identity JWT (20 forged variants), the CSP (0 violations on about 60 dashboard views), output escaping (every hostile string rendered as text), upload hardening (EXIF/GPS and trailing bytes removed, polyglots cleaned), the first-accept race, stale-socket cut-off (about 200 ms), the analytics numbers (every KPI compared with SQL, exact), a real FCM push round trip (test button, offer, message, dismiss), the OpenAPI reference (matches routes and real responses), the WhatsApp admin-only wall (28 API calls, channel auth, pages, signed media).

## What was verified, by feature

| Feature | Verified | Notes |
|---|---|---|
| Setup wizard, mode 1 and 2 | step order, validation, resume, locked after install, second tab mid-install, RTL, 375 px, the pizzasys portal proof and its specific errors | language chosen in the wizard is not applied to the wizard (it is DB-free before the install) |
| Sign-in, lockout, remember me, logout | uniform answers and timing, 5/min lockout per e-mail, shared budget with the native API | |
| Password reset, change, profile, delete | link once, expiry, other sessions end, own session stays | fixed (see below) |
| 2FA, recovery codes, passkeys | enable/confirm/disable, TOTP replay refused, recovery codes single use, virtual authenticator on `localhost` | no passkey rename UI |
| Roles and permissions | 56 dashboard URLs x guest/admin/agent, all 91 management routes, agent cannot reach others' chats by list, search, filter or export | |
| Categories, agents (staff) | create/edit/reorder/delete, in-use handling, translations, add staff, deactivate/reactivate, live sign-out on deactivation | |
| Widgets and the builder | every tab, draft vs publish, validation, domains (wildcards, ports, punycode, PSL refusal), hours, greetings, identity secret, embed snippets, live preview (device sizes, LTR/RTL, light/dark) | |
| Loader and customer page | `/w/{key}.js`, generic loader, inline iframe, hosted page, flip/popup/auto-hide/dismiss policies, unseen badge, reduced motion, JS API (preload queue, events, precedence), signed identity | |
| Live chat | offer, first accept (the loser sees "Taken by"), receipts, typing, 15 content cases, images both ways, transfer, end, rating, idle close, offline tickets and the e-mail reply, History filters/search/export | |
| Presence and notifications | auto-away, closed tab offline, quiet hours, first-login explainer, in-tab and OS notifications, real FCM push, dismiss on take-over | real Allow/Block click not possible headless |
| Dashboard and analytics | checklist in 8 states, live queue and team, KPIs/charts/heatmap/breakdown/CSV, agent scope | |
| WhatsApp | sessions, QR, hand-off code and wa.me link, inbound linking, signed webhooks (bad/tampered/missing/replayed), media, replies and every failure the mock produces, search/filters/export, retention, reconcile, admin-only isolation | the mock's QR never expires; real phone payloads untested |
| Security | CSP, headers, cookies, framing, CORS/origin, CSRF, rate limits and their messages, XSS corpus, uploads, privacy erase/export/retention, `/broadcasting/auth` matrix | |
| Operations | `schedule:list/run`, every command, Reverb down (REST polling carries on), a production-mode server (no traces), a real 500 with debug off | |

## Findings and what became of them

**Fixed** (each has a test; the fixes were then re-checked in Chrome on the same instances):

| ID | Sev | What | Fix |
|---|---|---|---|
| B-A-1 | S2 | Signing in with `/inbox` as the intended page: blank page | the inbox shell waits for the staff session instead of throwing |
| B-A-2 | S2 | Password change/reset did not end other sessions' pages; the old tab reloaded in a loop | `AuthenticateStaffSession` in the web group |
| B-A-3 | S2 | One wrong 2FA code destroyed the pending secret; the right code then failed | an unconfirmed setup is abandoned after 15 minutes; the wrong digits are cleared |
| B-A-4 | S2 | Forgot-password revealed which e-mails have an account | one uniform response (timing differs by about 180 ms: the mail is sent only for real accounts) |
| B-A-5, B-E-2 | S2 | The only administrator could delete their own account | guard in `ProfileController::destroy` |
| B-E-1 | S2 | Self-deleting agent left active chats orphaned | chats are requeued before the delete; tokens are removed with the account (B-A-18) |
| B-B-1, B-C-2 | S2/S3 | Agents "Last seen" always "Never" | presence changes write `users.last_seen_at`; an online agent shows "Active now" |
| B-A-6, B-E-4 | S3 | Throttled forms opened a bare 429 box | back to the form with "Try again in N seconds" |
| B-A-8, B-A-13, B-A-17 | S3/S4 | Wizard promised a settings page that does not exist; appearance said "account"; app URL accepted a path | honest copy; the URL must be an origin |
| B-A-9, B-A-10, B-A-11 | S3 | RTL switch thumb; 2FA axe criticals; `/history?q[]=1` 500 | fixed |
| B-B-2, B-B-3, B-B-4, B-B-5, B-B-8, B-B-10..12, B-B-14, B-B-15 | S3/S4 | long unbroken texts, preview font CSP, hours trap, silent category deletion, double publish, hints, default accent contrast, duplicate topic names, Hours contrast | see the changelog |
| B-C-3, B-C-4/B-D-5, B-C-5, B-C-6, B-C-7 | S3 | upload cap dead end, "thanks" for a refused rating, rating comment hidden, two contrast failures | see the changelog |
| B-D-1..4, B-D-6, B-D-7, B-D-11, B-D-12, B-D-14 | S3/S4 | tab title, subscribe race, rail badge, 403 after transfer, zero-category warning, logout presence, aria-pressed, `--force`, empty WhatsApp card | see the changelog |
| B-E-3, B-E-6, B-E-7, B-E-8, B-E-10, B-E-11, B-E-12 | S3/S4 | Agents table overflow, DevTools exposure, headers on errors, bidi in names, docs drift, deactivated agent shown online, `javascript:` page URLs | see the changelog |
| B-F-1..5, B-F-7, B-F-9, B-F-11 | S3/S4 | WhatsApp transient 409/429, exception name in text, transcript time basis, key removal, stale error, filters at 50 characters, wording | see the changelog |

**Left open** (S4 unless stated; none blocks a flow):

- **B-A-7 (S3)**: a cross-site form POST gets a branded 419 but the response sets a new anonymous session cookie, which replaces the real one (the browser withheld it under `SameSite=Lax`): a hostile page can sign staff out. Needs a change in how the web group starts sessions before the CSRF check; not done.
- **B-B-6, B-B-7, B-B-9, B-B-13, B-B-16, B-B-17**: the save toast mentions a draft after a settings-only change; an unlisted origin gets no developer-facing message (browsers do not run a 403 script); focus is lost to the body after a dialog closes; no way to discard a saved draft; an `AudioContext` warning when `open` runs before a gesture; out-of-range numbers are clamped silently.
- **B-D-8, B-D-9, B-D-10, B-D-15..19**: analytics axis labels and skeleton, an over-tall card, "Sign-in method" vs "Authentication", a repeated availability sentence, an API wording, quiet-hours save-per-keystroke, `dir="auto"` for visitor text in an RTL dashboard.
- **B-A-12, B-A-14, B-A-15, B-A-16, B-A-18 (part)**: forgot-password page title, small copy gaps in the password flow, wizard polish, post-install `GET /setup/*` answers 405 not 404, Back after logout fires 401s.
- **B-E-9, B-F-12**: 403-vs-404 reveals whether a WhatsApp or attachment ULID exists (a decision for you, see [pending-from-you.md](pending-from-you.md)); the conversation case is documented and the ULIDs are unguessable.
- **B-F-6, B-F-8, B-F-10**: the QR poll's 409 shows as a console error on every Start; a search for "100%" also finds "1000 units" (prefix search on the full-text index, by design); a reply OpenWA failed has no Retry.

**Not a bug / by design**:

- **B-C-1** (the 10 s cancel cooldown is skipped through the panel's own "Start a new chat"): the cooldown is per visitor on purpose (a test pins that two people on one network do not hold each other back) and "Start a new chat" starts a new visitor; the per-network start limit (3/min) and queue cap bound the abuse.
- **B-E-5** (404 for a guest on `DELETE /me/devices/{id}`): only for an id that is not a ULID (the route constraint); a ULID gets 401.

## Could not be verified here

Real push "Allow/Block" clicks (headless Chrome), audible sound, a real iOS keyboard and safe areas, Safari and Firefox (Chrome only), real SMTP, a real VAPID-less server state, Redis in production mode (the presence store ran on the database in these instances; the Redis variants are covered by PHPUnit), NATS and the pizzasys publisher, hardware passkeys, `https` cookies and HSTS, a real WhatsApp phone (QR expiry, message acks), production password rules (`APP_ENV=local`), a failing job on an async queue.
