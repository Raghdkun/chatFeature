/**
 * Shared by the cross-origin loader specs (widgets/loader-*.spec.ts): a live widget for the scenario's host page origin, and
 * console capture.
 */
import type { Page } from '@playwright/test';
import { createWidget, type Api, type WidgetPlan } from './api';
import type { Instance } from './scenarios';
import { unique } from './helpers';

/** The greeting pool every loader test shares: three agents with weights 3, 2 and 1 (in this order). */
export const POOL = [
    {
        body: 'Hi! Need a hand choosing the right pair?',
        agent_name: 'Sara',
        weight: 3,
    },
    {
        body: 'Questions about an order? Ask me anything.',
        agent_name: 'Omar',
        weight: 2,
    },
    {
        body: 'Welcome back! Anything I can help with today?',
        agent_name: 'Lena',
        weight: 1,
    },
];

const DEFAULT_CONFIG: Record<string, Record<string, unknown>> = {
    theme: { primary: '#7c3aed', launcherSize: 'lg' },
    launcher: { style: 'pill', label: 'Talk to Acme' },
    greetings: {
        delaySeconds: 1,
        intervalMinutes: 1,
        autoHideSeconds: 3,
        dismissPolicy: 'session',
    },
};

type Overrides = {
    name?: string;
    /** Allowed domains; default: the host page origin and every `*.example.localhost` sub-origin of it. */
    domains?: string[];
    categories?: string[];
    greetings?: WidgetPlan['greetings'];
    /** Merged over the default config (deep merge of the objects given). */
    config?: Record<string, unknown>;
    enabled?: boolean;
    settings?: Record<string, unknown>;
};

/**
 * Creates an enabled widget that may run on the instance's host page origin, with the shared greeting pool, three categories
 * and a fast greeting timeline (1 s delay, hidden after 3 s, repeat every minute). Everything can be overridden.
 */
export async function liveWidget(
    api: Api,
    instance: Instance,
    overrides: Overrides = {},
) {
    const port = instance.hostPort;
    const given = (overrides.config ?? {}) as Record<
        string,
        Record<string, unknown>
    >;
    // A section named by the test replaces the default one only where it names keys; other sections are taken as they are.
    const config: Record<string, Record<string, unknown>> = {
        ...given,
        ...Object.fromEntries(
            Object.entries(DEFAULT_CONFIG).map(([section, values]) => [
                section,
                { ...values, ...given[section] },
            ]),
        ),
    };

    return createWidget(api, {
        name: overrides.name ?? unique('Host widget'),
        domains: overrides.domains ?? [
            `localhost:${port}`,
            `*.example.localhost:${port}`,
        ],
        categories: overrides.categories ?? ['general', 'billing', 'sales'],
        greetings: overrides.greetings ?? POOL,
        config,
        enabled: overrides.enabled ?? true,
        settings: overrides.settings,
    });
}

export type ConsoleLog = {
    all: string[];
    errors: string[];
    warnings: string[];
};

/** Everything the page logs to its console, split by level. */
export function collectConsole(page: Page): ConsoleLog {
    const log: ConsoleLog = { all: [], errors: [], warnings: [] };

    page.on('console', (message) => {
        const text = `${message.type()}: ${message.text()}`;

        log.all.push(text);

        if (message.type() === 'error') {
            log.errors.push(text);
        }

        if (message.type() === 'warning') {
            log.warnings.push(text);
        }
    });

    return log;
}

/**
 * Makes the chat panel of ONE widget a page that never speaks: its iframe loads `/embed/<key>` (any query) as an empty document, so
 * no `ready` ever reaches the loader and the loader's handshake watchdog is what ends the wait. The real panel (P4) answers the
 * handshake at once, so a dead panel has to be provoked; the product is untouched. Call before the page opens the chat. Returns how
 * often the panel page was asked for.
 */
export async function silencePanel(
    page: Page,
    key: string,
): Promise<{ requests: () => number }> {
    let requests = 0;

    await page.route(`**/embed/${key}*`, async (route) => {
        if (route.request().resourceType() !== 'document') {
            await route.fallback();

            return;
        }

        requests += 1;
        await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><meta charset="utf-8"><title>Silent panel</title><p>Nothing here answers.</p>',
        });
    });

    return { requests: () => requests };
}
