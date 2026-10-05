# Still to do from your side

> Written during the real-browser pass of 2026-10-05. Everything here needs you (a person, a phone, an account, a server) or a decision of yours; none of it blocks local development. Tick items off as you do them.

## On your Mac (do this first)

- [ ] **Restart Reverb on its new port.** Homebrew Apache (`httpd`) already listens on port 8080, so Reverb could never start and every broadcast logged `Pusher error: <!DOCTYPE HTML ...>`. Your `.env` now uses `REVERB_PORT=8081` and `REVERB_SERVER_PORT=8081`. Restart the processes: `php artisan reverb:start` (and `composer dev` / `npm run dev` so Vite picks up the new `VITE_REVERB_PORT`).
- [ ] **Run the scheduler** in another terminal: `php artisan schedule:work`. Without it chats never time out, agents stay "online" after closing the tab and the analytics page stays empty. `composer dev` does not start it.
- [ ] **Reload the dashboard once** after the restart. Your `.env` also got the missing VAPID keys (`php artisan chat:bootstrap-secrets`), so Settings > Notifications no longer says "push is not set up on this server".
- [ ] **Look at your own widget**: Widgets > open it. The card and the Embed tab now say what is missing. For a page on your machine add its origin in the **Domains** tab (for example `localhost:8201`), press **Add** and then **Save changes** (it needs Save, not Publish), and make sure the widget is switched **on**.
- [ ] **Serve a category yourself**: Settings > Support categories > pick a category > Save. A new installation does this for the first admin automatically; your existing database predates that, and without it visitors always get "No agent is available". The dashboard and the inbox tell you when this is the case.

- [ ] **Switch the Inertia DevTools off in your `.env`** (`INERTIA_DEVTOOLS_ENABLED=false`; `.env.example` has it now). While `APP_ENV=local` they serve every dashboard page's props, staff and visitor data included, **without a sign-in** to anybody who can reach the dev server (found in the full verification pass). Only switch them on on a machine nobody else can reach.
- [ ] **Walk the verification list once yourself** where a machine could not: see "Could not be verified here" in [feature-verification.md](feature-verification.md) (real push permission clicks, Safari/Firefox/iPhone, a real WhatsApp phone).

## Accounts, keys and hardware only you have

- [ ] **A phone for WhatsApp.** Pair a **dedicated** number with OpenWA (Settings > WhatsApp > scan the QR) and walk the checklist in [whatsapp-openwa.md](whatsapp-openwa.md): the message-level payloads (`message.*`, acks) of the real OpenWA image have never been recorded, and the round trip through a real phone has never been run.
- [ ] **pizzasys:** the service-client token and the production (and optional testing) domain of your Auth Portal, if you want mode 2 on a real portal. Everything so far ran against a local clone of pizzasys.
- [ ] **SMTP credentials** (host, port 587/465, user, password) so offline tickets can be answered by e-mail. Until then `MAIL_MAILER=log` writes the mails to the log.
- [ ] **Hostinger:** the VPS, a domain (A record to the VPS) and an SSH key, then follow [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md). The stack has been proven on a Mac only: a real Let's Encrypt certificate, the Hostinger panel, `ufw` on Ubuntu and an amd64 run of the whole stack are still unverified.
- [ ] **Keep the first admin password off the real instance** if you ever used a seeded or test password with the public pizzasys repository.

## Decisions for you

- [ ] **`package-lock.json`** is a stale leftover from phase 0 (`npm ci` fails on it); the real lock is `pnpm-lock.yaml`, which the Docker image uses. Delete it, or regenerate it, or move the project to pnpm everywhere?
- [ ] **WhatsApp isolation oracle:** an agent gets 403 for a real WhatsApp id and 404 for a made-up one, which tells them whether the id exists. Collapse both to 404? (Currently a `test.fixme`.)
- [ ] **Replying to chats the phone started** is refused on purpose ("reply only to customers who wrote first"). Keep it?
- [ ] **A general settings page?** The wizard sets the app name, URL, language and time zone and nothing in the dashboard changes them afterwards (only the chat idle timeout, per widget). The wizard copy now says so. Build a page (about a day), or keep it CLI/DB-only?
- [ ] **Cross-site form POST signs staff out** (B-A-7 in [feature-verification.md](feature-verification.md)): the 419 response replaces the real session cookie with an anonymous one. A hostile page can log staff out (nothing more). Worth a session-start change before the CSRF check, or accept?
- [ ] **403 vs 404 for existing ULIDs** (WhatsApp ids, unsigned attachment ids, `already_claimed` naming the other agent): an agent can tell whether an id exists. The ids are unguessable; collapse them to 404 anyway?
- [ ] **Native app:** passkey sign-in and a real FCM channel are not built (about 3-5 days each, see [mobile-readiness.md](mobile-readiness.md)).

## Checks that need a real browser you drive yourself

- [ ] **Content-Security-Policy in production mode** (`CSP_MODE=enforce`): the checklist in [testing.md](testing.md) ("P7 hardening checks"). The first findings of that pass are already fixed (the builder preview and the widget panel); walk the rest once on the deployed site, with `CSP_MODE=report-only` first and the log (`csp.violation`) open.
- [ ] **Real push notifications**: enable them in Settings > Notifications on two browsers (Chrome and Safari or Firefox), close the dashboard tab and start a chat from a customer page. Clicking a real OS notification cannot be automated.
- [ ] **Safari / Firefox / a real phone** on a customer page with the widget (keyboard, safe areas, the pre-chat form). Only Chrome was driven so far.
- [ ] **Lighthouse and screen reader** pass of the dashboard and the visitor panel (phase 8, QA).

## Not built yet (phase 8, for later)

- QA matrix across browsers and phones, Lighthouse scores, an RTL pass in Arabic with real strings (`lang/ar.json` is partial).
- The PowerPoint deck with real screenshots (the P3 screenshots must be regenerated; P1, P2, P4, P5 and P6 pictures exist in `docs/screenshots`).
- The `v1.0.0` tag.
