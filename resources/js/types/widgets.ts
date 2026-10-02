/**
 * Hand-written mirror of docs/contracts/dashboard-pages-p3.md and docs/contracts/widget-config.md.
 *
 * Once the PHP Data classes (`app/Data/{Catalog,Widgets,Agents}`) are generated these become
 * `App.Data.*` aliases: replace the bodies below with `export type CategoryData = App.Data.Catalog.CategoryData`
 * (one file, no call site changes).
 */

import type { PresenceStatus } from '@/lib/chat/types';

export type OfflineMode = 'auto_hours' | 'always_online' | 'always_offline';
export type AuthSource = 'local' | 'pizzasys';
export type AuthModeName = 'fortify' | 'pizzasys';

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export type CategoryData = {
    ulid: string;
    slug: string;
    name: string;
    name_i18n: Record<string, string>;
    description: string | null;
    icon: string | null;
    color: string | null;
    sort_order: number;
    is_active: boolean;
    agents_count: number;
    widgets_count: number;
    /** Optional: lets the "My support categories" page name the widgets (see contract change request). */
    widgets?: { ulid: string; name: string }[];
};

export type CategoryInput = {
    name: string;
    slug?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    sort_order?: number;
    is_active?: boolean;
    name_i18n?: Record<string, string>;
};

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

export type AgentListItemData = {
    id: number;
    name: string;
    email: string;
    avatar: string | null;
    is_admin: boolean;
    is_agent: boolean;
    is_active: boolean;
    auth_source: AuthSource;
    category_ulids: string[];
    max_concurrent_chats: number;
    last_seen_at: string | null;
};

export type AgentsPageProps = {
    agents: AgentListItemData[];
    categories: CategoryData[];
    authMode: AuthModeName;
    canManageStaff: boolean;
    /** Each staff member's effective presence at the time of loading, by user id (P5; absent = unknown, shown offline). */
    presence?: Record<number, PresenceStatus>;
};

export type CreateStaffInput = {
    name: string;
    email: string;
    password: string;
    is_agent: true;
    category_ulids: string[];
};

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

export type WidgetData = {
    ulid: string;
    name: string;
    public_key: string;
    is_enabled: boolean;
    locale: string;
    idle_timeout_minutes: number;
    queue_timeout_seconds: number;
    offline_mode: OfflineMode;
    timezone: string;
    allow_non_browser_clients: boolean;
    config_version: number;
    has_identity_secret: boolean;
    has_unpublished_changes: boolean;
    whatsapp_connected: boolean;
    created_at: string;
    updated_at: string;
};

export type WidgetListItemData = Pick<
    WidgetData,
    | 'ulid'
    | 'name'
    | 'public_key'
    | 'is_enabled'
    | 'config_version'
    | 'has_unpublished_changes'
    | 'whatsapp_connected'
    | 'updated_at'
> & { domains_count: number; categories_count: number };

export type GreetingData = {
    ulid: string;
    body: string;
    agent_name: string | null;
    agent_avatar_url: string | null;
    locale: string | null;
    weight: number;
    is_active: boolean;
    sort_order: number;
};

export type WidgetSnippetsData = {
    script: string;
    iframe: string;
    hosted: string;
    identity_example: { php: string; node: string; python: string };
};

export type WidgetPreviewData = { embed_url: string; app_origin: string };

export type WidgetBuilderData = {
    widget: WidgetData;
    config: WidgetConfigData;
    draft_config: WidgetConfigData;
    greetings: GreetingData[];
    domains: string[];
    category_ulids: string[];
    all_categories: CategoryData[];
    snippets: WidgetSnippetsData;
    preview: WidgetPreviewData;
};

/* -------------------------------------------------------------------------- */
/* Widget config (docs/contracts/widget-config.md, `v: 1`)                    */
/* -------------------------------------------------------------------------- */

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ShadowLevel = 'none' | 'soft' | 'strong';
export type LauncherSize = 'sm' | 'md' | 'lg';
export type WidgetCorner = 'bottom-right' | 'bottom-left';
export type LauncherStyle = 'bubble' | 'pill';
export type LauncherIcon = 'chat' | 'help' | 'sparkle' | 'custom';
export type DismissPolicy = 'session' | 'interval' | 'never';

export type ThemeConfig = {
    mode: ThemeMode;
    primary: string;
    primaryText: string;
    accent: string;
    surface: string;
    text: string;
    fontFamily: string;
    fontUrl: string | null;
    radius: number;
    shadow: ShadowLevel;
    launcherSize: LauncherSize;
    panelWidth: number;
    panelHeight: number;
    position: WidgetCorner;
    offsetX: number;
    offsetY: number;
    zIndex: number;
};

export type LauncherConfig = {
    style: LauncherStyle;
    icon: LauncherIcon;
    iconUrl: string | null;
    label: string;
    avatarUrl: string | null;
};

export type TextKey =
    | 'title'
    | 'subtitle'
    | 'welcome'
    | 'categoryPrompt'
    | 'connecting'
    | 'noAgents'
    | 'offlineTitle'
    | 'offlineBody'
    | 'placeholder'
    | 'send'
    | 'attach'
    | 'endChat'
    | 'ratingTitle'
    | 'ratingPlaceholder'
    | 'thanks'
    | 'startNewChat'
    | 'poweredBy'
    | 'closeChat'
    | 'unread'
    | 'dismiss';
export type TextsConfig = Partial<Record<TextKey, string>>;

export type FeaturesConfig = {
    attachments: boolean;
    rating: boolean;
    sounds: boolean;
    preChat: boolean;
    whatsapp: boolean;
    offlineForm: boolean;
    titleBadge: boolean;
    endChatByVisitor: boolean;
    poweredBy: boolean;
};

export type PreChatFieldKey = 'name' | 'email' | 'phone';
export type PreChatFieldConfig = { enabled: boolean; required: boolean };

export type PreChatConfig = {
    fields: Record<PreChatFieldKey, PreChatFieldConfig>;
    consentText: string | null;
};

export type GreetingsSettings = {
    enabled: boolean;
    onPageLoad: boolean;
    delaySeconds: number;
    intervalMinutes: number;
    autoHideSeconds: number;
    dismissPolicy: DismissPolicy;
    showAgent: boolean;
};

/** `day`: 0 = Sunday .. 6 = Saturday. */
export type HoursRange = { day: number; start: string; end: string };
/**
 * `label` is optional on the wire (the server stores a blank name as `null`); the builder
 * normalises it to a string on hydrate and every reader still tolerates `null`.
 */
export type Holiday = { date: string; label: string | null };

export type HoursConfig = {
    mode: OfflineMode;
    timezone: string;
    schedule: HoursRange[];
    holidays: Holiday[];
};

export type RoutingWave = { afterSeconds: number; statuses: string[] };

export type RoutingConfig = {
    waves: RoutingWave[];
    wakeOfflineViaPush: boolean;
    queueTimeoutSeconds: number;
};

export type WidgetConfigData = {
    v: 1;
    defaultLocale: string;
    localeDetect: boolean;
    theme: ThemeConfig;
    launcher: LauncherConfig;
    texts: Record<string, TextsConfig>;
    features: FeaturesConfig;
    preChat: PreChatConfig;
    greetings: GreetingsSettings;
    hours: HoursConfig;
    routing: RoutingConfig;
    session: { idleTimeoutMinutes: number };
};

/** Config sections whose value is a plain object (patched with `config/section`). */
export type ConfigSectionKey =
    | 'theme'
    | 'launcher'
    | 'features'
    | 'preChat'
    | 'greetings'
    | 'hours'
    | 'routing'
    | 'session';

/* -------------------------------------------------------------------------- */
/* Resolved boot config (what the loader consumes; the preview builds one)    */
/* -------------------------------------------------------------------------- */

export type BootGreeting = {
    id: string;
    body: string;
    agentName: string | null;
    agentAvatarUrl: string | null;
    locale: string | null;
    weight: number;
};

export type ResolvedBootConfig = {
    v: 1;
    key: string;
    configVersion: number;
    generatedAt: string;
    api: { base: string; embed: string; appOrigin: string };
    config: Omit<WidgetConfigData, 'routing' | 'session'>;
    greetings: BootGreeting[];
    categories: { slug: string; label: string }[];
    availability: {
        online: boolean;
        openNow: boolean;
        nextOpenAt: string | null;
        whatsapp: { enabled: boolean };
    };
};
