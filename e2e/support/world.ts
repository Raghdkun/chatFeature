/**
 * A private "world" for one staff test: its own categories, its own agents and its own widget, created through the management API as
 * the administrator. The `p4-staff` scenario is one server shared by every spec file (they run in parallel), and presence, queues and
 * capacity are global to it: two tests that both switch Alice offline or count the queue would break each other. A world removes the
 * overlap at the root, because routing only ever offers a chat to agents who serve ITS category, only the widget's own visitors reach
 * them, and chat starts are budgeted per widget: nothing a test does here is visible to another test's agents, queue or limits.
 *
 *   const world = await createWorld(adminApi, instance, { agents: { ann: ['main'], ben: ['main', 'other'] }, categories: ['main', 'other'] });
 *   const ann = await actors.account(world.agents.ann, { presence: 'online', open: '/inbox' });
 *   const panel = await openCustomerSite(visitor.page, instance, { key: world.widget.key, open: true });
 *   await panel.startChat({ category: world.categories.main.slug, name: 'Vera' });
 *
 * The widget is configured like the seeded "Acme Storefront" (open around the clock, `online` agents at once and `away` ones after 20 s,
 * 45 s queue timeout, no greeting popup) and may run on the instance's customer site.
 */
import { Api, createWidget } from './api';
import { must } from './chat-api';
import { SEED_ROUTING } from './chat-seed';
import { unique } from './helpers';
import type { Instance } from './scenarios';
import { PASSWORD } from './users';

export type WorldAgent = {
    id: number;
    name: string;
    email: string;
    password: string;
};

export type WorldCategory = { ulid: string; slug: string; name: string };

export type World = {
    widget: { ulid: string; key: string; name: string };
    /** By the label the plan gave (`main`, `other`). */
    categories: Record<string, WorldCategory>;
    /** By the label the plan gave (`ann`, `ben`). */
    agents: Record<string, WorldAgent>;
};

export type WorldPlan = {
    /** Category labels; the widget offers all of them. Default `['main']`. */
    categories?: string[];
    /** Agent label -> the category labels they serve. Default: `ann` and `ben` serve `main`. */
    agents?: Record<string, string[]>;
    /** Merged over the widget's draft config (`routing`, `hours`, `features`, ...); published. */
    config?: Record<string, unknown>;
    /** Widget settings (`queue_timeout_seconds`, ...). */
    settings?: Record<string, unknown>;
};

const capitalise = (label: string): string =>
    label.charAt(0).toUpperCase() + label.slice(1);

/** Creates the categories, the agents (mode 1 accounts, password `PASSWORD`) and the widget of one test. */
export async function createWorld(
    adminApi: Api,
    instance: Instance,
    plan: WorldPlan = {},
): Promise<World> {
    const suffix = Math.random().toString(36).slice(2, 7);
    const labels = plan.categories ?? ['main'];
    const categories: Record<string, WorldCategory> = {};

    for (const label of labels) {
        const name = `${capitalise(label)} ${suffix}`;
        const created = must<{ ulid: string; slug: string; name: string }>(
            await adminApi.post('/api/v1/categories', {
                name,
                slug: `${label}-${suffix}`,
            }),
            `creating category ${label}`,
        );

        categories[label] = {
            ulid: created.ulid,
            slug: created.slug,
            name: created.name,
        };
    }

    const agents: Record<string, WorldAgent> = {};

    for (const [label, serves] of Object.entries(
        plan.agents ?? { ann: ['main'], ben: ['main'] },
    )) {
        const name = `${capitalise(label)} ${suffix}`;
        const email = `${label}.${suffix}@example.test`;
        const created = must<{ id: number }>(
            await adminApi.post('/api/v1/agents', {
                name,
                email,
                password: PASSWORD,
                is_agent: true,
                category_ulids: serves.map((category) => {
                    const known = categories[category];

                    if (!known) {
                        throw new Error(
                            `Agent ${label} serves unknown category ${category}`,
                        );
                    }

                    return known.ulid;
                }),
            }),
            `creating agent ${label}`,
        );

        agents[label] = { id: created.id, name, email, password: PASSWORD };
    }

    const widget = await createWidget(adminApi, {
        name: unique('World'),
        domains: [`localhost:${instance.hostPort}`],
        categories: Object.values(categories).map((category) => category.slug),
        settings: {
            offline_mode: 'always_online',
            queue_timeout_seconds: SEED_ROUTING.queueTimeoutSeconds,
            ...plan.settings,
        },
        config: {
            hours: { mode: 'always_online' },
            routing: SEED_ROUTING,
            greetings: { enabled: false },
            ...plan.config,
        },
    });

    return {
        widget: {
            ulid: widget.ulid,
            key: widget.key,
            name: widget.widget.name,
        },
        categories,
        agents,
    };
}
