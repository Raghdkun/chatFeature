import '@/tests/dom-polyfills';
import { act } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { AgentDashboard } from '@/components/dashboard/agent-dashboard';
import { choose } from '@/tests/dom';
import { click } from '@/tests/render';
import {
    ADMIN,
    renderStaff,
    useStaffBackend,
    waitFor,
} from '@/tests/staff-kit';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

// The network and the clock are real here: a loaded machine (CI, parallel agents) must not turn a slow tick into a failure.
vi.setConfig({ testTimeout: 20_000 });

const backend = useStaffBackend();

const select = (view: { byTestId: (id: string) => HTMLElement | null }) =>
    view.byTestId('presence-select') as HTMLSelectElement;

describe('the availability control on the agent landing page', () => {
    it('shows the status the server holds (read when the session starts) and saves a change', async () => {
        backend.current.state.presence = 'away';

        const { view, session } = await renderStaff(<AgentDashboard />);

        await waitFor(() => expect(select(view).value).toBe('away'));
        expect(select(view).disabled).toBe(false);

        await choose(select(view), 'offline');
        await waitFor(() =>
            expect(session.store.getState().presence).toBe('offline'),
        );

        expect(backend.current.state.presence).toBe('offline');
        expect(
            backend.current.calls('PUT', '/api/v1/me/presence')[0].body,
        ).toEqual({ status: 'offline' });
    });

    it('goes online from the landing page ("Online" is the automatic status) and starts beating', async () => {
        backend.current.state.presence = 'offline';

        const { view, session } = await renderStaff(<AgentDashboard />);

        await waitFor(() =>
            expect(
                view.byTestId('dashboard-availability-offline'),
            ).not.toBeNull(),
        );

        await click(view.byTestId('dashboard-availability-go-online'));
        await waitFor(() =>
            expect(session.store.getState().presence).toBe('online'),
        );

        expect(
            backend.current.calls('PUT', '/api/v1/me/presence')[0].body,
        ).toEqual({ status: 'online', automatic: true });
        expect(select(view).value).toBe('online');
        expect(view.byTestId('dashboard-availability-offline')).toBeNull();
        await waitFor(() =>
            expect(
                backend.current.calls('POST', '/api/v1/me/presence/heartbeat')
                    .length,
            ).toBeGreaterThan(0),
        );
    });

    it('follows the server: a status change it announces (auto-away, a sweep) shows at once', async () => {
        backend.current.state.presence = 'online';

        const { view, session } = await renderStaff(<AgentDashboard />);

        await waitFor(() => expect(select(view).value).toBe('online'));

        await act(async () =>
            session.controller.handle('presence.changed', {
                v: 1,
                userId: session.viewer.id,
                status: 'away',
            }),
        );

        expect(select(view).value).toBe('away');
    });

    it('does not claim a status before it knows one (the select waits, nothing is offered)', async () => {
        backend.current.state.offline = true;

        const { view } = await renderStaff(<AgentDashboard />);

        // The read failed (the network is down): unknown stays unknown.
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/me/presence').length,
            ).toBe(1),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });

        expect(select(view).disabled).toBe(true);
        expect(view.byTestId('dashboard-availability-offline')).toBeNull();
    });

    it('is the same control for an administrator who also takes chats', async () => {
        backend.current.state.presence = 'online';

        const { view } = await renderStaff(<AgentDashboard />, {
            viewer: ADMIN,
        });

        await waitFor(() => expect(select(view).value).toBe('online'));
    });
});
