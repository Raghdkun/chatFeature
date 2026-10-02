/**
 * Everything a WhatsApp dashboard test needs besides its own `vi.mock` calls (those are hoisted per file, so each test file declares them):
 *
 *   vi.mock('@inertiajs/react', async () => (await import('@/tests/inertia-mock')).inertiaMock());
 *   vi.mock('@laravel/echo-react', async () => (await import('@/tests/fake-echo')).fakeEchoModule());
 *   vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
 *
 * `useWaBackend()` starts an MSW server with the stateful fake of the WhatsApp management API; `renderWa()` mounts the real
 * `WhatsAppRealtimeProvider` (store, controller, Echo bindings) around the screen under test, signed in as an administrator.
 */
import '@/tests/dom-polyfills';
import { setupServer } from 'msw/node';
import { act, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vite-plus/test';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    useWaRealtime,
    type WaRealtimeContextValue,
} from '@/lib/realtime/whatsapp/context';
import { WhatsAppRealtimeProvider } from '@/lib/realtime/whatsapp/provider';
import type { WaApi } from '@/lib/whatsapp-api/client';
import { fakeEcho } from '@/tests/fake-echo';
import { resetInertiaMock } from '@/tests/inertia-mock';
import {
    createWaBackend,
    type WaBackend,
    type WaBackendOptions,
} from '@/tests/msw/whatsapp';
import { render, type Rendered } from '@/tests/render';

export type WaViewer = {
    id: number;
    name: string;
    isAdmin: boolean;
    isAgent: boolean;
};

export const ADMIN: WaViewer = {
    id: 1,
    name: 'Ada',
    isAdmin: true,
    isAgent: false,
};

/** An agent: the only role that must never see WhatsApp. */
export const AGENT: WaViewer = {
    id: 7,
    name: 'Sam',
    isAdmin: false,
    isAgent: true,
};

/** Starts the fake WhatsApp API for the tests of the current file; `current` is replaced for every test (fresh state). */
export function useWaBackend(options: WaBackendOptions = {}): {
    current: WaBackend;
    /** The MSW server, to override one route for a single test (`holder.server.use(http.post(...))`). */
    server: ReturnType<typeof setupServer>;
} {
    const server = setupServer();
    const holder = { current: createWaBackend(options), server };

    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    beforeEach(() => {
        holder.current = createWaBackend(options);
        server.use(...holder.current.handlers);
    });
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    return holder;
}

export type WaRender = {
    view: Rendered;
    session: WaRealtimeContextValue;
};

/** Mount `ui` inside the real WhatsApp provider, signed in as `viewer`, with a websocket (the fake Echo) unless `sockets: false`. */
export async function renderWa(
    ui: ReactElement,
    options: {
        viewer?: WaViewer;
        sockets?: boolean;
        locale?: string;
        api?: WaApi;
    } = {},
): Promise<WaRender> {
    const viewer = options.viewer ?? ADMIN;
    const locale = options.locale ?? 'en';
    const user = {
        id: viewer.id,
        name: viewer.name,
        email: `${viewer.name.toLowerCase()}@example.com`,
        avatar: null,
        is_admin: viewer.isAdmin,
        is_agent: viewer.isAgent,
        auth_source: 'local',
    };
    let captured: WaRealtimeContextValue | null = null;

    resetInertiaMock({
        locale,
        auth: { user, mode: 'fortify', capabilities: { portalUrl: null } },
    });
    fakeEcho.reset();

    function Capture() {
        captured = useWaRealtime();

        return null;
    }

    const view = await render(
        <TooltipProvider>
            <WhatsAppRealtimeProvider
                admin={viewer.isAdmin}
                sockets={options.sockets ?? true}
                api={options.api}
            >
                {viewer.isAdmin ? <Capture /> : null}
                {ui}
            </WhatsAppRealtimeProvider>
        </TooltipProvider>,
    );

    return {
        view,
        session: captured as unknown as WaRealtimeContextValue,
    };
}

/** Re-run `assertion` (letting React and the network settle between tries) until it passes or the timeout is hit. */
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
