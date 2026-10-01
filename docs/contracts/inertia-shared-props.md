# Inertia shared props

> Status: contract v1 (P0). Implemented in P1 (`HandleInertiaRequests`). Types live in `App.Data.Shared.*`.

Every Inertia page receives these props from `App\Http\Middleware\HandleInertiaRequests::share()`.
`resources/js/types/global.d.ts` (`sharedPageProps`) must mirror this table.

| Prop | Type | Notes |
|---|---|---|
| `name` | `string` | App name from settings (`app.name`), falls back to `config('app.name')`. |
| `auth.user` | `App.Data.Auth.AuthUserData \| null` | `{id,name,email,avatar,is_admin,is_agent,auth_source}`. `null` for guests. |
| `auth.mode` | `'fortify' \| 'pizzasys'` | Active auth driver. Drives the login page variant. Before install: `'fortify'`. |
| `auth.capabilities` | `{canRegister,canResetPassword,canManage2fa,profileEditable,portalUrl}` | From `AuthDriver::capabilities()`. Hide UI the active driver cannot honour. |
| `locale` | `string` | e.g. `en`. |
| `direction` | `'ltr' \| 'rtl'` | Derived from the locale; the root view also sets `<html lang dir>`. |
| `installed` | `boolean` | `false` only while the setup wizard is reachable. |
| `sidebarOpen` | `boolean` | Existing starter-kit prop (cookie). |
| `flash` | `{success?:string, error?:string}` | Existing starter-kit toast mechanism. |

**Rules**
- Pre-install the middleware must not touch the database: `auth.user = null`, `installed = false`,
  `name = config('app.name')`.
- `is_admin` / `is_agent` are the only role flags the frontend reads. Never ship permission lists,
  external tokens, pizzasys role names or `external_id` to the browser.
- Wizard pages (`resources/js/pages/setup/*`) additionally receive `setup: {step, mode?, steps[], hasToken}`
  from `SetupController`; they are not part of the global shared props.
