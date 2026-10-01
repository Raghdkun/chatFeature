# Setup wizard: routes, props, payloads

> Status: contract v1 (P1). Backend: track 1A (`app/Domain/Install`, `routes/web/setup.php`).
> Frontend: track 1B (`resources/js/pages/setup/*`). E2E: track 1C. Step semantics: [install-steps.md](install-steps.md).

The wizard is a **guest-only, pre-install** flow served by `SetupController`. It must work with **no database**
(session = file, state in `storage/app/install-state.json`). After the lock is written every `/setup*` URL returns 404.

## Routes (web group, name prefix `setup.`)

| Method | Path | Name | Purpose |
|---|---|---|---|
| GET | `/setup` | `setup.index` | Renders `setup/index` (the whole wizard, step chosen server-side). |
| POST | `/setup/token` | `setup.token` | `{token}` -> verifies the one-time `SETUP_TOKEN` (skipped when `APP_ENV=local`). Throttled 5/min. |
| POST | `/setup/mode` | `setup.mode` | `{mode:'fortify'\|'pizzasys'}` -> stores the mode. `pizzasys` is rejected with a validation error until P2 enables it. |
| POST | `/setup/admin` | `setup.admin` | Mode `fortify` only: `{name,email,password,password_confirmation}` -> stored (password hashed) in install state. |
| POST | `/setup/basics` | `setup.basics` | `{app_name,app_url,locale,timezone,idle_timeout_minutes}`. |
| POST | `/setup/run/{step}` | `setup.run` | JSON. Runs ONE step; see below. Idempotent. |
| GET | `/setup/state` | `setup.state` | JSON snapshot of `SetupProps` (for polling / resume). |

Form posts (`token`, `mode`, `admin`, `basics`) use the Inertia `<Form>` component and answer with a redirect back to
`setup.index` (validation errors flow through `errors` as usual). `run` is called with `fetch`/Inertia `useHttp` and answers JSON.

## `setup/index` props

```ts
type SetupStepKey =
  | 'welcome'   // setup-token gate + environment check
  | 'mode'      // choose Fortify vs pizzasys
  | 'admin'     // fortify only: first admin
  | 'basics'    // app name/url, locale, timezone, idle timeout
  | 'run'       // progress UI: migrations -> seed -> admin -> lock
  | 'done';     // success, link to /login

type SetupProps = {
  setup: {
    step: SetupStepKey;                      // the step the server wants rendered now
    steps: { key: SetupStepKey; label: string; status: 'pending' | 'current' | 'done' }[];
    needsToken: boolean;                     // true unless APP_ENV=local
    tokenVerified: boolean;
    mode: 'fortify' | 'pizzasys' | null;
    pizzasysAvailable: boolean;              // false in P1 (card shown disabled with a "coming soon" badge)
    environment: {
      ok: boolean;
      checks: { key: string; label: string; ok: boolean; message?: string }[]; // php ext, storage writable, APP_KEY, DB connect, redis (optional)
    };
    defaults: { app_name: string; app_url: string; locale: string; timezone: string; idle_timeout_minutes: number };
    admin: { name: string; email: string } | null;   // already-entered values (never the password)
    run: { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; message?: string }[];
  };
};
```

`direction`/`locale` shared props apply as usual. Wizard pages use `AuthLayout` (card variant) and the shared translations.

## `POST /setup/run/{step}` (JSON)

`{step}` ∈ `run-migrations | seed-defaults | create-admin | write-lock` (the `check-environment`, `choose-mode`, `app-basics`
steps are satisfied by the form posts above). Response:

```json
{ "status": "ok", "next": "seed-defaults" }
{ "status": "failed", "message": "Could not connect to the database: ..." }
{ "status": "ok", "next": null, "redirect": "/login" }   // write-lock
```

Rules: HTTP 200 even for `failed` (the UI shows `message`); 409 if another run holds `install.running`; 404 after install.
The client calls the steps in order, updating `run[]` locally from each response.

## Invariants (tested)

- Before install every non-setup web request redirects to `/setup`; every API request returns `503 {"error":"not_installed"}`.
- `/up`, build assets and `/setup/*` are exempt from the gate. After install `/setup*` is 404 and the gate is a no-op.
- The wizard never queries the database before `run-migrations` succeeds.
- `SETUP_TOKEN` is compared with `hash_equals`; it is never rendered into a page or response.

## Clarifications from the P1 implementation (binding)

- `done` is never served by the server (`/setup` is 404 after the lock): the client renders it after the `write-lock` response `{status:'ok', next:null, redirect:'/login'}`.
  In `APP_ENV=local` with a healthy environment the server starts directly at `mode` (no token step).
- Optional `?step=<key>` lets the UI go back to an earlier screen.
- `run` responses: failed responses may carry `fields` (per-field errors); ok responses may carry `message`. Statuses: `403` token not verified, `409` busy, `404` after install, `429` token throttling.
  The run endpoint needs the XSRF header (use Inertia `useHttp`).
- Environment check `message` values are withheld until the token is verified.
- Form errors come back under the field names: `token`, `mode`, `name`/`email`/`password`, and the basics field names.
- `SetupProps` is the PHP Data class `App\Data\Setup\SetupData` (generated TS type `App.Data.Setup.SetupData`); `GET /setup/state` returns `{setup: SetupData}`.
- The login page receives an extra boolean prop `canRegister`; no-access / inactive / unavailable messages are delivered as `errors.email`.
- Dev/e2e: `APP_ENV=local` + empty dedicated DB, or `APP_ENV=testing` + `APP_INSTALLED=false` + `SETUP_TOKEN=...`. Reset: `php artisan chat:install:reset --force` (local only, wipes the DB).
  Non-interactive install: `chat:install --mode=local` with `INSTALL_ADMIN_NAME/EMAIL/PASSWORD` (+ optional `INSTALL_APP_NAME/APP_URL/LOCALE/TIMEZONE/IDLE_TIMEOUT_MINUTES`); `INSTALL_STATE_DIR` relocates state + lock.
