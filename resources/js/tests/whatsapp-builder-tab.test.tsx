import '@/tests/dom-polyfills';
import { http, HttpResponse } from 'msw';
import { useReducer } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    builderReducer,
    createBuilderState,
} from '@/components/widgets/builder-state';
import { WhatsAppTab } from '@/components/widgets/builder/whatsapp-tab';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { WA_SETTINGS_DEFAULTS } from '@/lib/whatsapp-api/client';
import type { WaSettings } from '@/lib/whatsapp-api/types';
import { makeWaSession, resetWaFixtures } from '@/lib/whatsapp/fixtures';
import type { WhatsAppSession } from '@/lib/whatsapp/types';
import { body, choose } from '@/tests/dom';
import { makeBuilderData, makeWidget } from '@/tests/fixtures';
import { click } from '@/tests/render';
import { renderWa, useWaBackend, waitFor } from '@/tests/whatsapp-kit';
import type { WidgetBuilderData } from '@/types/widgets';

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

vi.setConfig({ testTimeout: 20_000 });

const backend = useWaBackend();
const byTestId = body.byTestId;

const READY = () =>
    makeWaSession({
        ulid: fakeUlid(5001),
        name: 'support-main',
        status: 'ready',
        phone: '+49 170 1234567',
        maskedPhone: '+49•••••••4567',
    });

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

/** The tab on a real builder reducer, with the two values it changes shown next to it. */
function Harness({ data }: { data: WidgetBuilderData }) {
    const [state, dispatch] = useReducer(
        builderReducer,
        data,
        createBuilderState,
    );

    return (
        <>
            <WhatsAppTab state={state} dispatch={dispatch} />
            <output data-testid="draft-feature">
                {String(state.doc.config.features.whatsapp)}
            </output>
            <output data-testid="meta-connected">
                {String(state.meta.whatsappConnected)}
            </output>
        </>
    );
}

async function open(
    options: {
        sessions?: WhatsAppSession[];
        linked?: string | null;
        settings?: Partial<WaSettings>;
        draft?: boolean;
        published?: boolean;
    } = {},
) {
    const sessions = options.sessions ?? [READY()];
    const data = makeBuilderData({ widget: makeWidget({ ulid: 'w1' }) });

    data.draft_config.features.whatsapp = options.draft ?? true;
    data.config.features.whatsapp = options.published ?? true;

    sessions.forEach((session) =>
        backend.current.state.sessions.set(session.ulid, session),
    );
    backend.current.state.settings = {
        ...WA_SETTINGS_DEFAULTS,
        enabled: true,
        ...options.settings,
    };

    if (options.linked !== undefined && options.linked !== null) {
        backend.current.state.widgetLinks.set('w1', options.linked);
    }

    return renderWa(<Harness data={data} />);
}

const select = () => byTestId('builder-whatsapp-session') as HTMLSelectElement;
const calls = (method: string) =>
    backend.current.state.calls.filter(
        (call) =>
            call.method === method &&
            call.path === '/api/v1/widgets/w1/whatsapp',
    );

describe('loading', () => {
    it('reads the widget link, the sessions and the settings once the tab opens', async () => {
        await open();

        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );

        const paths = backend.current.state.calls.map(
            (c) => `${c.method} ${c.path}`,
        );

        expect(paths).toContain('GET /api/v1/widgets/w1/whatsapp');
        expect(paths).toContain('GET /api/v1/whatsapp/sessions');
        expect(paths).toContain('GET /api/v1/whatsapp/settings');
    });

    it('says so and offers to try again when the sessions cannot be read', async () => {
        backend.current.state.offline = true;
        await open();

        await waitFor(() =>
            expect(byTestId('builder-whatsapp-error')).not.toBeNull(),
        );

        backend.current.state.offline = false;
        await click(byTestId('builder-whatsapp-retry'));
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
    });
});

describe('choosing the session', () => {
    it('offers only connected sessions, with their masked number, and "none"', async () => {
        const ready = READY();
        const waiting = makeWaSession({
            ulid: fakeUlid(5002),
            name: 'still-scanning',
            status: 'qr',
        });

        await open({ sessions: [ready, waiting] });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );

        const labels = Array.from(select().options).map((o) => o.textContent);

        expect(labels).toEqual([
            'None (WhatsApp stays hidden)',
            'support-main · +49•••••••4567',
        ]);
        expect(select().value).toBe('');
        expect(byTestId('builder-whatsapp-no-session')).toBeNull();
    });

    it('shows the chosen session: its state and the number masked, never the full one', async () => {
        const ready = READY();

        await open({ sessions: [ready], linked: ready.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-status')).not.toBeNull(),
        );

        expect(select().value).toBe(ready.ulid);
        expect(byTestId('builder-whatsapp-status')?.textContent).toContain(
            'support-main',
        );
        expect(byTestId('builder-whatsapp-status')?.textContent).toContain(
            'Connected',
        );
        expect(byTestId('builder-whatsapp-number')?.textContent).toBe(
            '+49•••••••4567',
        );
        expect(byTestId('builder-whatsapp-status')?.textContent).not.toContain(
            '1234567',
        );
        // No reveal control either: the builder never shows the real number.
        expect(byTestId('builder-whatsapp-number-toggle')).toBeNull();
    });

    it('keeps a linked session that is no longer connected visible, with its state, so it can be seen and changed', async () => {
        const down = makeWaSession({
            ulid: fakeUlid(5003),
            name: 'was-linked',
            status: 'disconnected',
        });

        await open({ sessions: [down, READY()], linked: down.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );

        expect(select().value).toBe(down.ulid);
        expect(
            Array.from(select().options).map((o) => o.textContent),
        ).toContain('was-linked (Disconnected)');
        expect(byTestId('builder-whatsapp-check-session')?.dataset.ok).toBe(
            'false',
        );
    });

    it('links the widget at once when a session is chosen, and tells the rest of the builder it is connected', async () => {
        const ready = READY();

        await open({ sessions: [ready] });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
        expect(byTestId('meta-connected')?.textContent).toBe('false');

        await choose(select(), ready.ulid);
        await waitFor(() => expect(calls('PUT')).toHaveLength(1));

        expect(calls('PUT')[0].body).toEqual({ session: ready.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-status')).not.toBeNull(),
        );
        expect(toast.success).toHaveBeenCalledWith(
            'Visitors of this widget are sent to support-main.',
        );
        expect(byTestId('meta-connected')?.textContent).toBe('true');
        expect(byTestId('builder-whatsapp-check-session')?.dataset.ok).toBe(
            'true',
        );
    });

    it('unlinks it again with "None"', async () => {
        const ready = READY();

        await open({ sessions: [ready], linked: ready.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-status')).not.toBeNull(),
        );
        await choose(select(), '');
        await waitFor(() => expect(calls('PUT')).toHaveLength(1));

        expect(calls('PUT')[0].body).toEqual({ session: null });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-status')).toBeNull(),
        );
        expect(toast.success).toHaveBeenCalledWith(
            'This widget no longer offers WhatsApp.',
        );
        expect(byTestId('meta-connected')?.textContent).toBe('false');
    });

    it("shows the server's refusal under the select and keeps the old choice", async () => {
        const ready = READY();

        await open({ sessions: [ready] });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
        backend.server.use(
            http.put('/api/v1/widgets/w1/whatsapp', () =>
                HttpResponse.json(
                    {
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid.',
                            details: {
                                session: [
                                    'The selected session is no longer available.',
                                ],
                            },
                        },
                    },
                    { status: 422 },
                ),
            ),
        );
        await choose(select(), ready.ulid);

        await waitFor(() =>
            expect(document.body.textContent).toContain('no longer available'),
        );
        expect(select().getAttribute('aria-invalid')).toBe('true');
        expect(select().value).toBe('');
    });

    it('says what to do when no session is connected', async () => {
        await open({
            sessions: [
                makeWaSession({ status: 'created', name: 'not-started' }),
            ],
        });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-no-session')).not.toBeNull(),
        );

        expect(
            byTestId('builder-whatsapp-no-session')
                ?.querySelector('a')
                ?.getAttribute('href'),
        ).toBe('/settings/whatsapp');
        expect(select().options).toHaveLength(1);
    });
});

describe('the hand-off preview', () => {
    it('shows the message with a sample code and the wa.me link of the chosen number', async () => {
        const ready = READY();

        await open({ sessions: [ready], linked: ready.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-link')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-message')?.textContent).toBe(
            'Hi! My support code is K7M2QX4P',
        );
        expect(byTestId('builder-whatsapp-link')?.textContent).toBe(
            'https://wa.me/491701234567?text=Hi!%20My%20support%20code%20is%20K7M2QX4P',
        );
    });

    it('uses the hand-off text from the settings', async () => {
        const ready = READY();

        await open({
            sessions: [ready],
            linked: ready.ulid,
            settings: { handoffText: 'Code :code, thanks' },
        });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-message')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-message')?.textContent).toBe(
            'Code K7M2QX4P, thanks',
        );
    });

    it('has no link until a session is chosen', async () => {
        await open();
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-no-link')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-link')).toBeNull();
    });
});

describe('why visitors do or do not get WhatsApp', () => {
    it('says they do when the switch, the published design and a connected session all agree', async () => {
        const ready = READY();

        await open({ sessions: [ready], linked: ready.ulid });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-checks')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-checks')?.dataset.serving).toBe(
            'true',
        );
        expect(byTestId('builder-whatsapp-checks')?.textContent).toContain(
            'Visitors are offered WhatsApp',
        );
    });

    it.each([
        [
            'the master switch is off',
            { settings: { enabled: false } },
            'check-global',
        ],
        [
            'the published design has it off',
            { published: false },
            'check-feature',
        ],
    ])('says what is missing when %s', async (_name, options, check) => {
        const ready = READY();

        await open({ sessions: [ready], linked: ready.ulid, ...options });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-checks')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-checks')?.dataset.serving).toBe(
            'false',
        );
        expect(byTestId(`builder-whatsapp-${check}`)?.dataset.ok).toBe('false');
        expect(byTestId('builder-whatsapp-checks')?.textContent).toContain(
            'not offered WhatsApp yet',
        );
    });

    it('says a connected session is missing when none is chosen', async () => {
        await open();
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-checks')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-check-session')?.dataset.ok).toBe(
            'false',
        );
    });

    it('reminds that the switch reaches visitors on Publish when the draft differs from what is live', async () => {
        const ready = READY();

        await open({
            sessions: [ready],
            linked: ready.ulid,
            draft: true,
            published: false,
        });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-unpublished')).not.toBeNull(),
        );

        expect(byTestId('builder-whatsapp-unpublished')?.textContent).toContain(
            'publish',
        );
    });
});

describe('the channel switch', () => {
    it('edits the draft (the same switch as the Features tab), nothing is saved by it', async () => {
        await open({ draft: false });
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
        expect(byTestId('draft-feature')?.textContent).toBe('false');

        await click(byTestId('builder-whatsapp-feature'));

        expect(byTestId('draft-feature')?.textContent).toBe('true');
        expect(
            byTestId('builder-whatsapp-feature')?.getAttribute('aria-checked'),
        ).toBe('true');
        // A draft change reaches no API by itself: Save / Publish do that.
        expect(calls('PUT')).toHaveLength(0);
    });

    it('marks the session part as applying immediately', async () => {
        await open();

        expect(byTestId('builder-whatsapp-session-card')?.dataset.live).toBe(
            'true',
        );
    });
});
