/** Shapes shared by the loader modules. The PHP `WidgetConfigData` is the source of truth (docs/contracts/widget-config.md). */

export type Dict = Record<string, unknown>;

export type Position = 'bottom-right' | 'bottom-left';

export interface Theme {
    mode: 'auto' | 'light' | 'dark';
    primary: string;
    primaryText: string;
    accent: string;
    surface: string;
    text: string;
    fontFamily: string;
    fontUrl: string | null;
    radius: number;
    shadow: 'none' | 'soft' | 'strong';
    launcherSize: 'sm' | 'md' | 'lg';
    panelWidth: number;
    panelHeight: number;
    position: Position;
    offsetX: number;
    offsetY: number;
    zIndex: number;
}

export interface Launcher {
    style: 'bubble' | 'pill';
    icon: 'chat' | 'help' | 'sparkle' | 'custom';
    iconUrl: string | null;
    label: string;
    avatarUrl: string | null;
}

export interface GreetingsConfig {
    enabled: boolean;
    onPageLoad: boolean;
    delaySeconds: number;
    intervalMinutes: number;
    autoHideSeconds: number;
    dismissPolicy: 'session' | 'interval' | 'never';
    showAgent: boolean;
}

export const FEATURE_NAMES = [
    'attachments',
    'rating',
    'sounds',
    'preChat',
    'whatsapp',
    'offlineForm',
    'titleBadge',
    'endChatByVisitor',
    'poweredBy',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, boolean>;

export type Texts = Record<string, Record<string, string>>;

export interface Visitor {
    name?: string;
    email?: string;
    phone?: string;
    meta?: Record<string, string | number | boolean>;
}

/** The part of the published config the loader itself consumes (the rest is forwarded untouched to the panel). */
export interface BaseConfig {
    defaultLocale: string;
    localeDetect: boolean;
    theme: Theme;
    launcher: Launcher;
    texts: Texts;
    features: Features;
    greetings: GreetingsConfig;
}

export interface Greeting {
    id: string;
    body: string;
    agentName: string | null;
    agentAvatarUrl: string | null;
    locale: string | null;
    weight: number;
}

export interface Category {
    slug: string;
    label: string;
    /** Passed to the panel as received (it validates them): the picker shows them without waiting for the config call. */
    description?: string;
    icon?: string;
    color?: string;
}

export interface Boot {
    key: string;
    configVersion: number;
    api: { embed: string; appOrigin: string };
    config: BaseConfig;
    greetings: Greeting[];
    categories: Category[];
    /** What the panel receives on `init`: rebuilt from validated fields, never the raw object the page handed us. */
    panel: Dict;
}

/** Sanitised client overrides (data-* < init settings < runtime update). */
export interface Overrides {
    locale?: string;
    defaultLocale?: string;
    theme?: Partial<Theme>;
    launcher?: Partial<Launcher>;
    texts?: Texts;
    features?: Partial<Features>;
    greetings?: Partial<GreetingsConfig>;
    categories?: string[];
    visitor?: Visitor;
    identityToken?: string;
    openOnLoad?: boolean;
    /** Opt-in: message bodies/previews reach `ChatFeature.on` handlers and DOM events (off by default). */
    exposeMessageContent?: boolean;
}

export interface Effective {
    /** Visitor locale (used to pick greetings): the browser's only when a texts block exists for it. */
    locale: string;
    /** Locale the texts are read from; `dir` follows it. */
    textLocale: string;
    /** Widget default locale (greeting fallback). */
    defaultLocale: string;
    dir: 'ltr' | 'rtl';
    theme: Theme;
    launcher: Launcher;
    features: Features;
    greetings: GreetingsConfig;
    categories: Category[];
    openOnLoad: boolean;
    text: (key: string, fallback: string) => string;
}

export type Status =
    | 'idle'
    | 'prechat'
    | 'queued'
    | 'active'
    | 'ended'
    | 'offline'
    | 'closed';

export interface AgentInfo {
    name: string;
    avatarUrl?: string;
}

export interface ChatState {
    status: Status;
    open: boolean;
    unread: number;
    agent?: AgentInfo;
}

/** The first six are the ones the panel may forward with an `event` message; the rest are the loader's own. */
export const EVENT_NAMES = [
    'chat-started',
    'chat-ended',
    'agent-joined',
    'message-sent',
    'message-received',
    'rating-submitted',
    'ready',
    'open',
    'close',
    'unread-changed',
    'greeting-shown',
    'greeting-dismissed',
    'error',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const PANEL_EVENTS: readonly string[] = EVENT_NAMES.slice(0, 6);

export interface Envelope {
    ns: 'chatfeature';
    v: 1;
    type: string;
    id?: string;
    payload: Dict;
}
