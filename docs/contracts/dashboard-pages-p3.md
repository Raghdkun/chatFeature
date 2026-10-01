# Dashboard pages and management API for categories, widgets, agents (P3)

> Status: contract v1, **implemented in P3 and reviewed** (`v0.3.0`; this text is the implemented truth). Tracks: **3A** backend (controllers, Data classes, routes), **3C** dashboard UI, **3B** loader (only the embed/snippet parts).
> Shapes are PHP Data classes in `app/Data/{Catalog,Widgets,Agents}/` with `#[TypeScript]`; the TS below is what they generate (`resources/js/types/generated.d.ts`). `resources/js/types/widgets.ts` is still a hand-written mirror used by the screens, so keep it in step.
> Config schema: [widget-config.md](widget-config.md). REST conventions + errors: [rest-shapes.md](rest-shapes.md).

## Data shapes

```ts
type CategoryData = {
  ulid: string; slug: string; name: string; name_i18n: Record<string, string>; description: string | null;
  icon: string | null; color: string | null; sort_order: number; is_active: boolean;
  agents_count: number;   // active agents (is_agent) serving it
  widgets_count: number;  // widgets it is enabled on
};   // no per-category widget list is sent: an optional `widgets?` that `resources/js/types/widgets.ts` and the support-categories page read is NOT implemented server-side (the page falls back to the count)
type GreetingData = {
  ulid: string; body: string; agent_name: string | null; agent_avatar_url: string | null;
  locale: string | null; weight: number; is_active: boolean; sort_order: number;
};
type WidgetData = {
  ulid: string; name: string; public_key: string; is_enabled: boolean; locale: string;
  idle_timeout_minutes: number; queue_timeout_seconds: number;
  offline_mode: 'auto_hours' | 'always_online' | 'always_offline'; timezone: string;   // (a PHP enum, generated as such)
  allow_non_browser_clients: boolean; config_version: number; has_identity_secret: boolean;
  has_unpublished_changes: boolean; whatsapp_connected: boolean; created_at: string; updated_at: string;
};
type WidgetListItemData = Pick<WidgetData, 'ulid' | 'name' | 'public_key' | 'is_enabled' | 'config_version' | 'has_unpublished_changes' | 'whatsapp_connected' | 'updated_at'>
  & { domains_count: number; categories_count: number };
type WidgetSnippetsData = { script: string; iframe: string; hosted: string; identity_example: { php: string; node: string; python: string } };
type WidgetBuilderData = {   // Inertia props of widgets/builder
  widget: WidgetData;
  config: WidgetConfigData;            // published
  draft_config: WidgetConfigData;      // what the builder edits
  greetings: GreetingData[];
  domains: string[];                   // normalised entries, wildcards allowed (*.example.com), optional :port, optional http:// prefix (see widget-config.md)
  category_ulids: string[];            // enabled categories, in display order
  all_categories: CategoryData[];
  snippets: WidgetSnippetsData;
  preview: { embed_url: string; app_origin: string };
};
type AgentListItemData = {
  id: number; name: string; email: string; avatar: string | null;
  is_admin: boolean; is_agent: boolean; is_active: boolean; auth_source: 'local' | 'pizzasys';
  category_ulids: string[]; max_concurrent_chats: number; last_seen_at: string | null;
};
```
`WidgetConfigData` is the config object of [widget-config.md](widget-config.md) (nested Data classes mirroring it exactly, strict validation, defaults filled).

## Inertia pages (web, group `['auth','session.valid','chat.access']`; `admin` unless noted; files `routes/web/{widgets,catalog,agents}.php`)

| Route | Page component | Props |
|---|---|---|
| `GET /widgets` | `widgets/index` | `{ widgets: WidgetListItemData[] }` |
| `GET /widgets/{ulid}` | `widgets/builder` | `WidgetBuilderData` |
| `GET /categories` | `categories/index` | `{ categories: CategoryData[] }` |
| `GET /agents` | `agents/index` | `{ agents: AgentListItemData[], categories: CategoryData[], authMode: 'fortify' \| 'pizzasys', canManageStaff: boolean }` (`canManageStaff` is true only in mode 1: create/deactivate local staff; in mode 2 roles come from pizzasys) |
| `GET /settings/support-categories` | `settings/support-categories` | `{ categories: CategoryData[] (active only), selected: string[] }` |

`/settings/support-categories` is gated by the **staff group only** (`auth`, `session.valid`, `chat.access`: any active admin or agent can open it; no `is_agent` check on the page). The **settings menu entry only shows for `is_agent`**
users, and saving is refused with `403` by `PUT /me/categories` for everyone without `is_agent` (an admin who does not take chats sees the page read-only).

Creating a widget: `POST /api/v1/widgets {name}` returns the new `WidgetData`; the UI then navigates to `/widgets/{ulid}`.

### What is live and what is a draft (builder)

The builder edits five slices, each saved by its own endpoint; **Save** writes the dirty ones one by one (independent, errors mapped onto fields), **Publish** saves, then publishes.

| Slice (tab) | Endpoint | Reaches visitors |
|---|---|---|
| Config object (branding, texts, features, pre-chat, greetings *settings*, hours, routing, session) | `PUT /widgets/{ulid}/draft` | **Draft**: only after `POST /widgets/{ulid}/publish` (`has_unpublished_changes`, `config_version` + 1) |
| Settings columns (name, locale, timeouts, offline mode, timezone, `allow_non_browser_clients`) | `PATCH /widgets/{ulid}` | **Live** immediately (the mirrored config fields are written into both published and draft) |
| Greeting pool | `PUT /widgets/{ulid}/greetings` | **Live** immediately |
| Domains | `PUT /widgets/{ulid}/domains` | **Live** immediately |
| Enabled categories | `PUT /widgets/{ulid}/categories` | **Live** immediately |
| `is_enabled` | `PATCH /widgets/{ulid} { is_enabled }` | **Live**, and its own confirmed action (an enable/disable control with a confirmation); saving the other settings never sends it |

## Management REST (Sanctum cookie/bearer, group `['auth:sanctum','session.valid','chat.access']`, `admin` unless noted; envelope `{data}` / `{error}`)

| Method + path | Body | Result / rules |
|---|---|---|
| `GET /categories` (any staff) · `POST /categories` · `PATCH /categories/{ulid}` · `DELETE /categories/{ulid}` | `{ name, slug?, description?, icon?, color?, sort_order?, is_active?, name_i18n? }` | `CategoryData`. Slug unique + auto-generated; delete is soft and `409 category_in_use` while an active conversation uses it (conversations arrive in P4: guard through an interface that returns false until then). |
| `GET/PUT /me/categories` (agents: `is_agent`, else `403`) | `{ category_ulids: string[] }` | replaces the set of categories the caller serves; only active categories. Both answer `{ data: { category_ulids } }`. |
| `GET /agents` · `POST /agents` · `PATCH /agents/{id}` · `PATCH /agents/{id}/categories` | `POST` (mode 1 only): `{ name, email, password, is_agent?: true, category_ulids?: [] }` — **there is no `is_admin`**: a created account is always an active, e-mail-verified agent with `auth_source: local`; `PATCH`: `{ max_concurrent_chats? (1..50), is_active?, is_agent? }` (is_active / is_agent only in mode 1, else `409 managed_by_auth_portal`); categories: `{ category_ulids }` | `AgentListItemData`. Admins may always assign categories (both modes) but only to accounts with `is_agent`, else `409 not_an_agent`. Rules: an admin cannot deactivate themselves (`409 cannot_deactivate_self`); `is_agent=false` is only allowed for admin-role accounts (agents always take chats, otherwise `422`) and **clears the categories** the account served; deactivating revokes the account's API tokens. |
| `GET /widgets` · `POST /widgets` · `GET /widgets/{ulid}` · `PATCH /widgets/{ulid}` · `DELETE /widgets/{ulid}` | `POST {name}` (<= 120; created **disabled**); `PATCH {name?, is_enabled?, locale?, idle_timeout_minutes? (5..10080), queue_timeout_seconds? (15..600), offline_mode?, timezone? (any PHP timezone incl. backward-compatible ones, `all_with_bc`), allow_non_browser_clients?}`; `DELETE` is soft (`204`) | `WidgetData` (never the identity secret). |
| `PUT /widgets/{ulid}/draft` | `{ config: WidgetConfigData }` (strict; unknown keys -> 422, details under `config.*`) | saves `draft_config` and returns `WidgetData` (does not affect visitors). |
| `POST /widgets/{ulid}/publish` | — | copies draft -> published, bumps `config_version`, busts the `/w/{key}.js` + config caches; returns `WidgetData`. |
| `PUT /widgets/{ulid}/domains` | `{ domains: string[] }` (<= 50) | `{ data: { domains } }`: normalised/validated entries (lower-case, punycode, optional `http://` prefix kept / `https://` dropped, no path/userinfo, `*.` wildcard only as the first label and never on a public suffix, optional port, <= 255 characters). Rules in widget-config.md. |
| `PUT /widgets/{ulid}/greetings` | `{ greetings: { ulid?, body (<=2000, plain text), agent_name?, agent_avatar_url?, locale?, weight (1..100), is_active, sort_order }[] }` (<= 100) | replaces the pool; returns the list of `GreetingData`. |
| `PUT /widgets/{ulid}/categories` | `{ category_ulids: string[] }` (ordered) | replaces enabled categories; returns `{ data: { category_ulids } }`. |
| `POST /widgets/{ulid}/rotate-secret` | — | `{ data: { identity_secret } }` — the plaintext is returned **once**; only the encrypted value is stored. |
| `GET /widgets/{ulid}/snippet` | — | `WidgetSnippetsData`. |

Authorization: agents get `403 forbidden` on everything marked admin; admins can do everything. All writes are audited (`AuditLogger`; secrets redacted). No endpoint ever returns `identity_secret` after rotation. Pages and endpoints use the route aliases `session.valid`, `chat.access`, `admin`.

## Public endpoints used by the loader/builder preview (see rest-shapes.md)
`GET /api/v1/public/widgets/{key}/config`, `GET .../availability`, `GET /w/{key}.js`, `GET /embed/{key}[?preview=1]`, `GET /c/{key}` — implemented by 3A, consumed by 3B/3C.
