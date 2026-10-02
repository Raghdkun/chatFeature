/**
 * What an analytics page test needs besides its own `vi.mock('@inertiajs/react', ...)`: the MSW server with the fake analytics API, a
 * viewer, and the page props. `useAnalyticsBackend()` starts the server for the tests of the file and gives every test a fresh backend.
 */
import '@/tests/dom-polyfills';
import { setupServer } from 'msw/node';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vite-plus/test';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AnalyticsRole } from '@/lib/analytics/types';
import AnalyticsIndex from '@/pages/analytics/index';
import {
    createAnalyticsBackend,
    type AnalyticsBackend,
    type AnalyticsBackendOptions,
} from '@/tests/msw/analytics';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { render, type Rendered } from '@/tests/render';
import { ulidLike } from '@/tests/msw/analytics';
import type { AnalyticsPageProps } from '@/types/analytics';

export const TODAY = '2026-03-27';

export const WIDGET_MAIN = ulidLike('WIDGET', 1);
export const WIDGET_OLD = ulidLike('WIDGET', 2);
export const TOPIC_BILLING = ulidLike('TOPIC', 1);

// Recharts measures its container; jsdom has no layout, so it complains about a 0 x 0 chart on every render. The tests read the table and the
// text alternatives, not the drawn lines.
const warn = console.warn.bind(console);

console.warn = (...args: unknown[]) => {
    if (!String(args[0]).includes('of chart should be greater than 0')) {
        warn(...args);
    }
};

export const OPTIONS: AnalyticsPageProps['options'] = {
    widgets: [
        {
            key: '01HWIDGET00000000000000001',
            label: 'Main site',
            deleted: false,
        },
        { key: WIDGET_OLD, label: 'Old shop', deleted: true },
    ],
    categories: [
        {
            key: '01HCATEGORY0000000000000001',
            label: 'Billing',
            deleted: false,
        },
    ],
    agents: [
        { key: '7', label: 'Sam', deleted: false },
        { key: '8', label: 'Omar', deleted: false },
    ],
};

export function pageProps(
    role: AnalyticsRole = 'admin',
    overrides: Partial<AnalyticsPageProps> = {},
): AnalyticsPageProps {
    return {
        scope: {
            role,
            userId: role === 'admin' ? 1 : 7,
            whatsapp: role === 'admin',
        },
        timezone: 'UTC',
        today: TODAY,
        filters: {
            from: '2026-02-26',
            to: TODAY,
            widget: null,
            category: null,
            agent: null,
            compare: true,
        },
        options:
            role === 'admin'
                ? OPTIONS
                : { widgets: [], categories: [], agents: [] },
        ...overrides,
    };
}

export function useAnalyticsBackend(options: AnalyticsBackendOptions = {}): {
    current: AnalyticsBackend;
    server: ReturnType<typeof setupServer>;
    /** Replace the backend (a different role / numbers) for the rest of the test. */
    use: (next: AnalyticsBackendOptions) => AnalyticsBackend;
} {
    const server = setupServer();
    const holder = {
        current: createAnalyticsBackend(options),
        server,
        use: (next: AnalyticsBackendOptions) => {
            holder.current = createAnalyticsBackend(next);
            server.resetHandlers();
            server.use(...holder.current.handlers);

            return holder.current;
        },
    };

    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    beforeEach(() => {
        holder.current = createAnalyticsBackend(options);
        server.use(...holder.current.handlers);
    });
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    return holder;
}

export async function waitFor(
    assertion: () => void,
    timeoutMs = 5000,
): Promise<void> {
    const started = Date.now();

    for (;;) {
        try {
            assertion();

            return;
        } catch (error) {
            if (Date.now() - started > timeoutMs) {
                throw error;
            }

            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
            });
        }
    }
}

export function viewerFor(role: AnalyticsRole) {
    return {
        id: role === 'admin' ? 1 : 7,
        name: role === 'admin' ? 'Ada' : 'Sam',
        email: 'x@x.test',
        avatar: null,
        is_admin: role === 'admin',
        is_agent: true,
        auth_source: 'local',
    };
}

/** Mounts the analytics page for a viewer of `role` and waits for the first numbers. */
export async function renderAnalytics(
    role: AnalyticsRole = 'admin',
    overrides: Partial<AnalyticsPageProps> = {},
    locale = 'en',
): Promise<Rendered> {
    resetInertiaMock({
        locale,
        auth: { user: viewerFor(role), mode: 'fortify', capabilities: {} },
    });

    const view = await render(
        <TooltipProvider>
            <AnalyticsIndex {...pageProps(role, overrides)} />
        </TooltipProvider>,
    );

    await waitFor(() => {
        if (view.byTestId('kpi-handled-value') === null) {
            throw new Error('the overview has not arrived');
        }
    });

    return view;
}
