/** Realistic payloads for the dashboard tests (shapes of docs/contracts/dashboard-pages-p3.md). */
import { defaultWidgetConfig } from '@/lib/widget-config';
import type {
    AgentListItemData,
    CategoryData,
    GreetingData,
    WidgetBuilderData,
    WidgetData,
    WidgetListItemData,
} from '@/types/widgets';

export function makeCategory(
    overrides: Partial<CategoryData> = {},
): CategoryData {
    return {
        ulid: 'cat1',
        slug: 'sales',
        name: 'Sales',
        name_i18n: {},
        description: 'Pricing and quotes',
        icon: 'shopping-cart',
        color: '#2563eb',
        sort_order: 0,
        is_active: true,
        agents_count: 2,
        widgets_count: 1,
        ...overrides,
    };
}

export const CATEGORIES: CategoryData[] = [
    makeCategory(),
    makeCategory({
        ulid: 'cat2',
        slug: 'billing',
        name: 'Billing',
        description: null,
        icon: 'credit-card',
        color: '#7c3aed',
        sort_order: 1,
        agents_count: 1,
        widgets_count: 0,
    }),
    makeCategory({
        ulid: 'cat3',
        slug: 'tech',
        name: 'Technical support',
        description: 'Bugs and how-tos',
        icon: 'wrench',
        color: '#0f766e',
        sort_order: 2,
        is_active: false,
        agents_count: 0,
        widgets_count: 2,
    }),
];

export function makeAgent(
    overrides: Partial<AgentListItemData> = {},
): AgentListItemData {
    return {
        id: 1,
        name: 'Sara Ahmed',
        email: 'sara@example.com',
        avatar: null,
        is_admin: false,
        is_agent: true,
        is_active: true,
        auth_source: 'local',
        category_ulids: ['cat1'],
        max_concurrent_chats: 3,
        last_seen_at: null,
        ...overrides,
    };
}

export const AGENTS: AgentListItemData[] = [
    makeAgent(),
    makeAgent({
        id: 2,
        name: 'Omar Haddad',
        email: 'omar@example.com',
        is_admin: true,
        is_agent: false,
        category_ulids: [],
        last_seen_at: '2026-09-30T11:55:00.000Z',
    }),
    makeAgent({
        id: 3,
        name: 'Lina Kassab',
        email: 'lina@example.com',
        category_ulids: ['cat1', 'cat2'],
        is_active: false,
        max_concurrent_chats: 5,
    }),
];

export function makeListItem(
    overrides: Partial<WidgetListItemData> = {},
): WidgetListItemData {
    return {
        ulid: 'w1',
        name: 'Marketing site',
        public_key: 'wk_abc123',
        is_enabled: true,
        config_version: 3,
        has_unpublished_changes: false,
        whatsapp_connected: false,
        updated_at: '2026-09-30T10:00:00.000Z',
        domains_count: 2,
        categories_count: 1,
        ...overrides,
    };
}

export function makeWidget(overrides: Partial<WidgetData> = {}): WidgetData {
    return {
        ulid: 'w1',
        name: 'Marketing site',
        public_key: 'wk_abc123',
        is_enabled: true,
        locale: 'en',
        idle_timeout_minutes: 120,
        queue_timeout_seconds: 90,
        offline_mode: 'auto_hours',
        timezone: 'UTC',
        allow_non_browser_clients: false,
        config_version: 3,
        has_identity_secret: false,
        has_unpublished_changes: false,
        whatsapp_connected: false,
        created_at: '2026-09-01T10:00:00.000Z',
        updated_at: '2026-09-30T10:00:00.000Z',
        ...overrides,
    };
}

export function makeGreeting(
    overrides: Partial<GreetingData> = {},
): GreetingData {
    return {
        ulid: 'g1',
        body: 'Hi! Need a hand choosing a plan?',
        agent_name: 'Sara',
        agent_avatar_url: null,
        locale: null,
        weight: 2,
        is_active: true,
        sort_order: 0,
        ...overrides,
    };
}

export function makeBuilderData(
    overrides: Partial<WidgetBuilderData> = {},
): WidgetBuilderData {
    const config = defaultWidgetConfig();

    return {
        widget: makeWidget(),
        config,
        draft_config: structuredClone(config),
        greetings: [
            makeGreeting(),
            makeGreeting({
                ulid: 'g2',
                body: 'Questions about billing?',
                agent_name: 'Omar',
                sort_order: 1,
                weight: 1,
            }),
        ],
        domains: ['example.com'],
        category_ulids: ['cat1'],
        all_categories: CATEGORIES,
        snippets: {
            script: '<script src="https://chat.example.test/w/wk_abc123.js" async></script>',
            iframe: '<iframe src="https://chat.example.test/embed/wk_abc123?mode=inline"></iframe>',
            hosted: 'https://chat.example.test/c/wk_abc123',
            identity_example: {
                php: '<?php // sign with the identity secret',
                node: '// node: sign with the identity secret',
                python: '# python: sign with the identity secret',
            },
        },
        preview: {
            embed_url: 'https://chat.example.test/embed/wk_abc123?preview=1',
            app_origin: 'https://chat.example.test',
        },
        ...overrides,
    };
}
