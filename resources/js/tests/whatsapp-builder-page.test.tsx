/**
 * The WhatsApp tab inside the real widget builder page (the tab itself is covered in whatsapp-builder-tab.test.tsx): it is one of the
 * tabs, opens on demand and only then reads the WhatsApp API, and linking a session updates the Features tab's "not connected" notice.
 */
import '@/tests/dom-polyfills';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { WA_SETTINGS_DEFAULTS } from '@/lib/whatsapp-api/client';
import { makeWaSession, resetWaFixtures } from '@/lib/whatsapp/fixtures';
import WidgetBuilder from '@/pages/widgets/builder';
import { byTestId, choose, mouseDown } from '@/tests/dom';
import { setViewportWidth } from '@/tests/dom-polyfills';
import { fakeApi } from '@/tests/fake-api';
import { makeBuilderData, makeWidget } from '@/tests/fixtures';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { flush, render, type Rendered } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

const session = makeWaSession({
    ulid: fakeUlid(5001),
    name: 'support-main',
    status: 'ready',
    phone: '+491701234567',
    maskedPhone: '+49•••••••4567',
});

const link = (connected: boolean) => ({
    widget: { ulid: 'w1', name: 'Marketing site' },
    session: connected ? { ulid: session.ulid, name: session.name } : null,
    status: connected ? 'ready' : null,
    maskedPhone: connected ? session.maskedPhone : null,
    connected,
});

beforeEach(() => {
    resetInertiaMock();
    setViewportWidth(1440);
    resetFixtures();
    resetWaFixtures();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    setViewportWidth(1440);
});

async function setup() {
    const data = makeBuilderData({ widget: makeWidget() });

    data.draft_config.features.whatsapp = true;
    data.config.features.whatsapp = true;

    const api = fakeApi({
        'GET /widget/v1/loader.js': { status: 404 },
        'GET /api/v1/widgets/w1/whatsapp': { json: { data: link(false) } },
        'GET /api/v1/whatsapp/sessions': { json: { data: [session] } },
        'GET /api/v1/whatsapp/settings': {
            json: { data: { ...WA_SETTINGS_DEFAULTS, enabled: true } },
        },
        'PUT /api/v1/widgets/w1/whatsapp': { json: { data: link(true) } },
    });
    const view = await render(<WidgetBuilder {...data} />);

    await flush();

    return { api, view };
}

const openTab = (view: Rendered, tab: string) =>
    mouseDown(byTestId(view.container, `builder-tab-${tab}`));

describe('the WhatsApp tab in the builder', () => {
    it('sits after Features, reads the WhatsApp API only when it is opened', async () => {
        const { api, view } = await setup();
        const tabs = Array.from(
            view.container.querySelectorAll('[role="tab"]'),
        ).map((tab) => tab.getAttribute('data-testid'));

        expect(tabs.slice(3, 5)).toEqual([
            'builder-tab-features',
            'builder-tab-whatsapp',
        ]);
        expect(api.to('GET', '/api/v1/whatsapp/sessions')).toHaveLength(0);

        await openTab(view, 'whatsapp');
        await flush();

        expect(api.to('GET', '/api/v1/whatsapp/sessions')).toHaveLength(1);
        expect(view.byTestId('builder-panel-whatsapp')).not.toBeNull();
    });

    it('linking a session clears the "no session is connected" notice of the Features tab', async () => {
        const { api, view } = await setup();

        await openTab(view, 'features');
        expect(view.byTestId('builder-whatsapp-notice')).not.toBeNull();

        await openTab(view, 'whatsapp');
        await flush();
        await choose(
            view.byTestId('builder-whatsapp-session') as HTMLSelectElement,
            session.ulid,
        );
        await flush();

        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/whatsapp')).toEqual({
            session: session.ulid,
        });

        await openTab(view, 'features');
        expect(view.byTestId('builder-whatsapp-notice')).toBeNull();
    });
});
