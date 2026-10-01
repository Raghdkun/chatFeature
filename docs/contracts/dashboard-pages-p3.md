# Dashboard pages and management API for categories, widgets, agents (P3)

> Status: contract v1 (written before P3). Tracks: **3A** backend (controllers, Data classes, routes), **3C** dashboard UI, **3B** loader (only the embed/snippet parts).
> Shapes are PHP Data classes in `app/Data/{Catalog,Widgets,Agents}/` with `#[TypeScript]`; the TS below is what they generate (3C hand-writes `resources/js/types/widgets.ts`
> until the generated types exist after merge). Config schema: [widget-config.md](widget-config.md). REST conventions + errors: [rest-shapes.md](rest-shapes.md).

## Data shapes

```ts
type CategoryData = {
  ulid: string; slug: string; name: string; name_i18n: Record<string, string>; description: string | null;
  icon: string | null; color: string | null; sort_order: number; is_active: boolean;
  agents_count: number; widgets_count: number;
};
type GreetingData = {
  ulid: string; body: string; agent_name: string | null; agent_avatar_url: string | null;
  locale: string | null; weight: number; is_active: boolean; sort_order: number;
};
type WidgetData = {
  ulid: string; name: string; public_key: string; is_enabled: boolean; locale: string;
  idle_timeout_minutes: number; queue_timeout_seconds: number;
  offline_mode: 'auto_hours' | 'always_online' | 'always_offline'; timezone: string;
  allow_non_browser_clients: boolean; config_version: number; has_identity_secret: boolean;
  has_unpublished_changes: boolean; whatsapp_connected: boolean; created_at: string; updated_at: string;
};
type WidgetListItemData = Pick<WidgetData, 'ulid' | 'name' | 'public_key' | 'is_enabled' | 'config_version' | 'has_unpublished_changes' | 'whatsapp_connected' | 'updated_at'>
  & { domains_count: number; categories_count: number };
type WidgetSnippetsData = { script: string; iframe: string; hosted: string; identity_example: { php: string; node: string; python: string } };
type WidgetBuilderData = {
  widget: WidgetData;
  config: WidgetConfigData;            // published
  draft_config: WidgetConfigData;      // what the builder edits
  greetings: GreetingData[];
  domains: string[];                   // normalised hosts, wildcards allowed (*.example.com), optional :port
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
| `GET /settings/support-categories` (any staff member incl. agents) | `settings/support-categories` | `{ categories: CategoryData[], selected: string[] }` |

Creating a widget: `POST /api/v1/widgets {name}` returns the new `WidgetData`; the UI then navigates to `/widgets/{ulid}`.

## Management REST (Sanctum cookie/bearer, group `['auth:sanctum','session.valid','chat.access']`, `admin` unless noted; envelope `{data}` / `{error}`)

| Method + path | Body | Result / rules |
|---|---|---|
| `GET /categories` (any staff) · `POST /categories` · `PATCH /categories/{ulid}` · `DELETE /categories/{ulid}` | `{ name, slug?, description?, icon?, color?, sort_order?, is_active?, name_i18n? }` | `CategoryData`. Slug unique + auto-generated; delete is soft and `409 category_in_use` while an active conversation uses it (conversations arrive in P4: guard through an interface that returns false until then). |
| `PUT /me/categories` (any agent) | `{ category_ulids: string[] }` | replaces the set of categories the caller serves; only active categories. |
| `GET /agents` · `POST /agents` · `PATCH /agents/{id}` · `PATCH /agents/{id}/categories` | `POST` (mode 1 only): `{ name, email, password, is_agent?: true, category_ulids?: [] }`; `PATCH`: `{ max_concurrent_chats?, is_active?, is_agent? }` (is_active / is_agent only in mode 1, else `409 managed_by_auth_portal`); categories: `{ category_ulids }` | `AgentListItemData`. Admins may always assign categories (both modes). |
| `GET /widgets` · `POST /widgets` · `GET /widgets/{ulid}` · `PATCH /widgets/{ulid}` · `DELETE /widgets/{ulid}` | `POST {name}`; `PATCH {name?, is_enabled?, locale?, idle_timeout_minutes? (5..10080), queue_timeout_seconds? (15..600), offline_mode?, timezone?, allow_non_browser_clients?}` | `WidgetData` (never the identity secret). |
| `PUT /widgets/{ulid}/draft` | `{ config: WidgetConfigData }` (strict; unknown keys -> 422) | saves `draft_config` (does not affect visitors). |
| `POST /widgets/{ulid}/publish` | — | copies draft -> published, bumps `config_version`, busts the `/w/{key}.js` + config caches; returns `WidgetData`. |
| `PUT /widgets/{ulid}/domains` | `{ domains: string[] }` | normalised/validated hosts (lower-case, punycode, no scheme/path/userinfo, `*.` wildcard only as the first label, optional port). |
| `PUT /widgets/{ulid}/greetings` | `{ greetings: { ulid?, body (<=2000, plain text), agent_name?, agent_avatar_url?, locale?, weight (1..100), is_active, sort_order }[] }` | replaces the pool. |
| `PUT /widgets/{ulid}/categories` | `{ category_ulids: string[] }` (ordered) | replaces enabled categories. |
| `POST /widgets/{ulid}/rotate-secret` | — | `{ data: { identity_secret } }` — the plaintext is returned **once**; only the encrypted value is stored. |
| `GET /widgets/{ulid}/snippet` | — | `WidgetSnippetsData`. |

Authorization: agents get `403 forbidden` on everything marked admin; admins can do everything. All writes are audited (`AuditLogger`). No endpoint ever returns `identity_secret` after creation/rotation.

## Public endpoints used by the loader/builder preview (see rest-shapes.md)
`GET /api/v1/public/widgets/{key}/config`, `GET .../availability`, `GET /w/{key}.js`, `GET /embed/{key}[?preview=1]`, `GET /c/{key}` — implemented by 3A, consumed by 3B/3C.
