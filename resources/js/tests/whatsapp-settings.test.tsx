import '@/tests/dom-polyfills';
import { http, HttpResponse } from 'msw';
import { act } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { WA_SETTINGS_DEFAULTS } from '@/lib/whatsapp-api/client';
import type { WaSettings } from '@/lib/whatsapp-api/types';
import { makeWaSession, resetWaFixtures } from '@/lib/whatsapp/fixtures';
import type { WhatsAppSession } from '@/lib/whatsapp/types';
import WhatsAppSettings from '@/pages/settings/whatsapp';
import { body, byLabelText, fill } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { click } from '@/tests/render';
import {
    ADMIN,
    AGENT,
    renderWa,
    useWaBackend,
    waitFor,
    type WaRender,
} from '@/tests/whatsapp-kit';

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

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

const settings = (overrides: Partial<WaSettings> = {}): WaSettings => ({
    ...WA_SETTINGS_DEFAULTS,
    baseUrl: 'https://openwa.example.com',
    hasApiKey: true,
    ...overrides,
});

async function open(
    options: {
        sessions?: WhatsAppSession[];
        settings?: Partial<WaSettings>;
        privateHostsAllowed?: boolean;
        viewer?: typeof ADMIN;
        sockets?: boolean;
    } = {},
): Promise<WaRender> {
    const sessions = options.sessions ?? [];
    const current = settings(options.settings);

    sessions.forEach((session) =>
        backend.current.state.sessions.set(session.ulid, session),
    );
    backend.current.state.settings = current;

    return renderWa(
        <WhatsAppSettings
            sessions={sessions}
            settings={current}
            widgets={[]}
            privateHostsAllowed={options.privateHostsAllowed ?? false}
        />,
        { viewer: options.viewer, sockets: options.sockets },
    );
}

const calls = (method: string, suffix: string) =>
    backend.current.state.calls.filter(
        (call) => call.method === method && call.path.endsWith(suffix),
    );
const input = (id: string) => byTestId(id) as HTMLInputElement;
const dialog = () => byTestId('wa-pacing-dialog') as HTMLElement;

describe('who may see it', () => {
    it('shows an administrator the whole page, ban-risk notice first', async () => {
        await open();

        expect(byTestId('settings-whatsapp')).not.toBeNull();
        expect(byTestId('wa-risk-notice')?.textContent).toContain(
            'Use a dedicated number',
        );
        expect(byTestId('wa-risk-notice')?.textContent).toContain('unofficial');
        expect(byTestId('wa-connection-card')).not.toBeNull();
        expect(byTestId('wa-sessions-card')).not.toBeNull();
        expect(byTestId('wa-behavior-card')).not.toBeNull();
    });

    it('shows an agent nothing, and sends no request', async () => {
        await open({ viewer: AGENT });

        expect(byTestId('settings-whatsapp-forbidden')).not.toBeNull();
        expect(byTestId('settings-whatsapp')).toBeNull();
        expect(byTestId('wa-connection-card')).toBeNull();
        expect(backend.current.state.calls).toHaveLength(0);
        expect(fakeEcho.channels()).toEqual([]);
    });
});

describe('the connection', () => {
    it('shows the saved address, says a key is saved and never shows it', async () => {
        await open();

        expect(input('wa-base-url').value).toBe('https://openwa.example.com');
        expect(input('wa-api-key').value).toBe('');
        expect(byTestId('wa-api-key-saved')?.textContent).toContain(
            'API key saved',
        );
        expect(byTestId('wa-api-key-hint')?.textContent).toContain(
            'Leave empty',
        );
        expect(
            (byTestId('wa-connection-save') as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('asks for the key again when the address changes (the server never reuses a key for a new address)', async () => {
        await open();
        await fill(input('wa-base-url'), 'https://other.example.com');

        expect(byTestId('wa-api-key-hint')?.textContent).toContain(
            'needs the key entered again',
        );

        await click(byTestId('wa-connection-save'));

        expect(byTestId('wa-connection-form')?.textContent).toContain(
            'Enter the API key again',
        );
        expect(calls('PUT', '/whatsapp/settings')).toHaveLength(0);
    });

    it('saves a new address with its key, clears the key input and says so', async () => {
        await open();
        await fill(input('wa-base-url'), 'https://other.example.com');
        await fill(input('wa-api-key'), 'a-new-secret-key');
        await click(byTestId('wa-connection-save'));

        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')).toHaveLength(1),
        );

        expect(calls('PUT', '/whatsapp/settings')[0].body).toEqual({
            base_url: 'https://other.example.com',
            api_key: 'a-new-secret-key',
        });
        await waitFor(() => expect(input('wa-api-key').value).toBe(''));
        expect(toast.success).toHaveBeenCalledWith('Connection saved.');
        expect(input('wa-base-url').value).toBe('https://other.example.com');
    });

    it('saves only the key when only the key was typed', async () => {
        await open();
        await fill(input('wa-api-key'), 'rotated-key');
        await click(byTestId('wa-connection-save'));

        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')).toHaveLength(1),
        );
        expect(calls('PUT', '/whatsapp/settings')[0].body).toEqual({
            api_key: 'rotated-key',
        });
    });

    it('rejects an address that is not http(s) before asking the server', async () => {
        await open({ settings: { hasApiKey: false } });
        await fill(input('wa-base-url'), 'openwa:2785');
        await fill(input('wa-api-key'), 'k');
        await click(byTestId('wa-connection-save'));

        expect(byTestId('wa-connection-form')?.textContent).toContain(
            'starts with http',
        );
        expect(calls('PUT', '/whatsapp/settings')).toHaveLength(0);
    });

    it("puts the server's validation message under the field", async () => {
        await open({ settings: { hasApiKey: false } });
        await fill(input('wa-base-url'), 'https://openwa.example.com/?x=1');
        await fill(input('wa-api-key'), 'k');
        await click(byTestId('wa-connection-save'));

        await waitFor(() =>
            expect(byTestId('wa-connection-form')?.textContent).toContain(
                'must be a plain address',
            ),
        );
        expect(input('wa-base-url').getAttribute('aria-invalid')).toBe('true');
    });

    it('can remove the saved key', async () => {
        await open();
        await click(byTestId('wa-connection-clear-key'));

        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')).toHaveLength(1),
        );
        expect(calls('PUT', '/whatsapp/settings')[0].body).toEqual({
            clear_api_key: true,
        });
        await waitFor(() => expect(byTestId('wa-api-key-saved')).toBeNull());
    });

    it('warns early about a private address when the server will not allow it, and not when it will', async () => {
        const closed = await open({
            settings: { baseUrl: 'http://openwa:2785' },
            privateHostsAllowed: false,
        });

        expect(byTestId('wa-private-host-notice')?.textContent).toContain(
            'PORTAL_ALLOW_PRIVATE_HOSTS',
        );
        await closed.view.unmount();

        await open({
            settings: { baseUrl: 'http://openwa:2785' },
            privateHostsAllowed: true,
        });
        expect(byTestId('wa-private-host-notice')).toBeNull();
    });

    it('tests the saved connection and shows the role and the engine', async () => {
        await open();
        await click(byTestId('wa-connection-test'));

        await waitFor(() => expect(byTestId('wa-test-result')).not.toBeNull());

        expect(byTestId('wa-test-result')?.dataset.status).toBe('ok');
        expect(byTestId('wa-test-result')?.textContent).toContain('admin role');
        expect(byTestId('wa-test-result')?.textContent).toContain(
            'whatsapp-web.js',
        );
        expect(byTestId('wa-test-cannot-operate')).toBeNull();
    });

    it('warns when the key cannot operate', async () => {
        backend.current.state.connection = {
            ok: true,
            role: 'viewer',
            engine: 'baileys',
            canOperate: false,
        };
        await open();
        await click(byTestId('wa-connection-test'));

        await waitFor(() =>
            expect(byTestId('wa-test-cannot-operate')).not.toBeNull(),
        );
    });

    it.each([
        ['unauthorized', 'refused the API key', 'operator or admin role'],
        ['unreachable', 'could not be reached', 'is running'],
        ['blocked', 'not allowed', 'PORTAL_ALLOW_PRIVATE_HOSTS'],
        ['unexpected_response', 'does not look like OpenWA', '2785'],
    ])(
        'explains a failed test (%s) with the reason and what to do',
        async (reason, title, hint) => {
            backend.current.state.connection = {
                ok: false,
                reason,
                message: 'Server says: no.',
            };
            await open();
            await click(byTestId('wa-connection-test'));

            await waitFor(() =>
                expect(byTestId('wa-test-result')).not.toBeNull(),
            );

            const result = byTestId('wa-test-result') as HTMLElement;

            expect(result.dataset.reason).toBe(reason);
            expect(result.textContent).toContain(title);
            expect(result.textContent).toContain('Server says: no.');
            expect(result.textContent).toContain(hint);
        },
    );

    it('offers the test only for what is saved: not while the form has changes', async () => {
        await open();
        await fill(input('wa-base-url'), 'https://other.example.com');

        expect(
            (byTestId('wa-connection-test') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(byTestId('wa-connection-dirty-hint')).not.toBeNull();
    });
});

describe('the sessions', () => {
    const ready = () =>
        makeWaSession({
            ulid: fakeUlid(5001),
            name: 'support-main',
            status: 'ready',
            phone: '+491701234567',
            maskedPhone: '+49•••••••4567',
            linkedWidgetsCount: 2,
            isLinkedToWidgets: true,
        });

    it('lists each session with its state, the masked number and what it is wired to', async () => {
        const session = ready();

        await open({ sessions: [session] });

        const row = byTestId(`wa-session-${session.ulid}`) as HTMLElement;

        expect(row.dataset.status).toBe('ready');
        expect(byTestId(`wa-session-status-${session.ulid}`)?.textContent).toBe(
            'Connected',
        );
        expect(byTestId(`wa-session-phone-${session.ulid}`)?.textContent).toBe(
            '+49•••••••4567',
        );
        expect(
            byTestId(`wa-session-webhook-${session.ulid}`)?.textContent,
        ).toBe('Registered');
        expect(row.textContent).toContain('2 widgets');
        expect(row.textContent).toContain('whatsapp-web.js');
        expect(
            byTestId(`wa-session-limits-${session.ulid}`)?.textContent,
        ).toContain('200 a day');
    });

    it('reveals the number only when asked, and hides it again', async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-phone-${session.ulid}-toggle`));

        expect(byTestId(`wa-session-phone-${session.ulid}`)?.textContent).toBe(
            '+491701234567',
        );
        await click(byTestId(`wa-session-phone-${session.ulid}-toggle`));
        expect(byTestId(`wa-session-phone-${session.ulid}`)?.textContent).toBe(
            '+49•••••••4567',
        );
    });

    it('says what an empty list is for', async () => {
        await open();

        expect(byTestId('wa-sessions-empty')?.textContent).toContain(
            'No sessions yet',
        );
    });

    it('adds a session with a valid name', async () => {
        await open();
        await fill(input('wa-session-name'), 'sales-line');
        await click(byTestId('wa-session-create'));

        await waitFor(() =>
            expect(calls('POST', '/whatsapp/sessions')).toHaveLength(1),
        );

        expect(calls('POST', '/whatsapp/sessions')[0].body).toEqual({
            name: 'sales-line',
        });
        await waitFor(() =>
            expect(byTestId('wa-sessions-list')?.textContent).toContain(
                'sales-line',
            ),
        );
        expect(input('wa-session-name').value).toBe('');
        expect(toast.success).toHaveBeenCalledWith('Session sales-line added.');
        // A new session is not started by being created: Start is the next step.
        expect(byTestId('wa-sessions-list')?.textContent).toContain(
            'Not started',
        );
    });

    it.each([
        ['ab', 'Use 3 to 50 characters'],
        ['a'.repeat(51), 'Use 3 to 50 characters'],
        ['sales line', 'letters, digits and hyphens only'],
        ['sales_line', 'letters, digits and hyphens only'],
        ['säles', 'letters, digits and hyphens only'],
    ])(
        'refuses the name "%s" before asking the server',
        async (name, message) => {
            await open();
            await fill(input('wa-session-name'), name);
            await act(async () => {
                input('wa-session-name').form?.dispatchEvent(
                    new Event('submit', { bubbles: true, cancelable: true }),
                );
            });

            expect(byTestId('wa-session-form')?.textContent).toContain(message);
            expect(calls('POST', '/whatsapp/sessions')).toHaveLength(0);
        },
    );

    it('says when the name is taken, or was only just deleted', async () => {
        const taken = makeWaSession({ name: 'support-main' });

        await open({ sessions: [taken] });
        await fill(input('wa-session-name'), 'support-main');
        await click(byTestId('wa-session-create'));
        await waitFor(() =>
            expect(byTestId('wa-session-form')?.textContent).toContain(
                'already exists',
            ),
        );

        backend.current.state.createError = {
            status: 409,
            code: 'session_name_teardown_pending',
        };
        await fill(input('wa-session-name'), 'fresh-name');
        await click(byTestId('wa-session-create'));
        await waitFor(() =>
            expect(byTestId('wa-session-form')?.textContent).toContain(
                'Wait a few seconds',
            ),
        );
    });

    it('starts a session and opens its QR code', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5002),
            name: 'new-line',
            status: 'created',
            phone: null,
            maskedPhone: null,
        });

        await open({ sessions: [session] });
        backend.current.state.qr.set(session.ulid, PNG);
        await click(byTestId(`wa-session-start-${session.ulid}`));

        await waitFor(() =>
            expect(calls('POST', `/${session.ulid}/start`)).toHaveLength(1),
        );
        await waitFor(() => expect(byTestId('wa-qr-dialog')).not.toBeNull());
        await waitFor(() => expect(byTestId('wa-qr-image')).not.toBeNull());

        expect(byTestId('wa-qr-image')?.getAttribute('src')).toBe(PNG);
        expect(byTestId('wa-qr-dialog')?.textContent).toContain(
            'Linked devices',
        );
        expect(byTestId('wa-qr-dialog')?.textContent).toContain(
            'Link a device',
        );
        expect(byTestId('wa-qr-tile')?.className).toContain('bg-white');
        expect(byTestId(`wa-session-status-${session.ulid}`)?.textContent).toBe(
            'Starting',
        );
    });

    it('closes the QR dialog when the session connects (the websocket event is as good as the poll)', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5003),
            name: 'qr-line',
            status: 'qr',
            phone: null,
            maskedPhone: null,
        });

        await open({ sessions: [session] });
        backend.current.state.qr.set(session.ulid, PNG);
        await click(byTestId(`wa-session-qr-${session.ulid}`));
        await waitFor(() => expect(byTestId('wa-qr-image')).not.toBeNull());

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.session.status', {
                v: 1,
                session: { ...session, status: 'ready' },
            }),
        );

        await waitFor(() => expect(byTestId('wa-qr-dialog')).toBeNull());
        expect(toast.success).toHaveBeenCalledWith('qr-line is connected.');
        expect(byTestId(`wa-session-status-${session.ulid}`)?.textContent).toBe(
            'Connected',
        );
    });

    it('closes the QR dialog when the poll sees the scan, and the image is only ever a data URL PNG', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5004),
            name: 'scan-line',
            status: 'qr',
            phone: null,
            maskedPhone: null,
        });

        await open({ sessions: [session] });
        backend.current.state.qr.set(session.ulid, 'https://evil.test/x.png');
        await click(byTestId(`wa-session-qr-${session.ulid}`));

        // A picture that is not a base64 PNG is never rendered as one.
        await waitFor(() => expect(byTestId('wa-qr-waiting')).not.toBeNull());
        expect(byTestId('wa-qr-image')).toBeNull();

        backend.current.state.qr.set(session.ulid, PNG);
        backend.current.state.scanned.add(session.ulid);
        await click(byTestId('wa-qr-refresh'));

        await waitFor(() => expect(byTestId('wa-qr-dialog')).toBeNull());
    });

    it('tells a stopped session to start again instead of waiting for a code that cannot come', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5005),
            name: 'idle-line',
            status: 'starting',
            phone: null,
            maskedPhone: null,
        });

        await open({ sessions: [session] });
        backend.current.state.sessions.set(session.ulid, {
            ...session,
            status: 'disconnected',
        });
        await click(byTestId(`wa-session-qr-${session.ulid}`));

        await waitFor(() => expect(byTestId('wa-qr-stopped')).not.toBeNull());
        expect(byTestId('wa-qr-restart')).not.toBeNull();
    });

    it('stops a session only after a confirmation', async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-stop-${session.ulid}`));

        expect(byTestId('wa-stop-dialog')?.textContent).toContain(
            'Stop support-main?',
        );
        expect(calls('POST', `/${session.ulid}/stop`)).toHaveLength(0);

        await click(byTestId('wa-stop-dialog-confirm'));
        await waitFor(() =>
            expect(calls('POST', `/${session.ulid}/stop`)).toHaveLength(1),
        );
        await waitFor(() =>
            expect(
                byTestId(`wa-session-status-${session.ulid}`)?.textContent,
            ).toBe('Disconnected'),
        );
        expect(byTestId('wa-stop-dialog')).toBeNull();
    });

    it('deletes a session only after a confirmation that names the widgets it stops', async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-delete-${session.ulid}`));

        expect(byTestId('wa-delete-widgets')?.textContent).toContain(
            '2 widgets',
        );
        await click(byTestId('wa-delete-dialog-confirm'));

        await waitFor(() =>
            expect(byTestId(`wa-session-${session.ulid}`)).toBeNull(),
        );
        expect(toast.success).toHaveBeenCalledWith('support-main deleted.');
    });

    it('offers to delete here anyway when OpenWA cannot be asked, and only then', async () => {
        const session = ready();

        await open({ sessions: [session] });
        backend.current.state.openWaDown.add(session.ulid);
        await click(byTestId(`wa-session-delete-${session.ulid}`));
        await click(byTestId('wa-delete-dialog-confirm'));

        await waitFor(() => expect(byTestId('wa-delete-force')).not.toBeNull());
        expect(byTestId('wa-delete-dialog-error')?.textContent).toContain(
            'could not be reached',
        );
        expect(byTestId(`wa-session-${session.ulid}`)).not.toBeNull();

        await click(byTestId('wa-delete-force-confirm'));
        await waitFor(() =>
            expect(byTestId(`wa-session-${session.ulid}`)).toBeNull(),
        );
        expect(
            calls('DELETE', `/${session.ulid}`).map(
                (c) => c.query.force ?? null,
            ),
        ).toEqual([null, '1']);
    });

    it('refreshes a session from OpenWA on request', async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-sync-${session.ulid}`));

        await waitFor(() =>
            expect(calls('POST', `/${session.ulid}/sync`)).toHaveLength(1),
        );
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                'Status of support-main refreshed.',
            ),
        );
    });

    it('follows a session live: its status changes without a reload', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5006),
            name: 'live-line',
            status: 'starting',
        });

        await open({ sessions: [session] });
        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.session.status', {
                v: 1,
                session: { ...session, status: 'qr' },
            }),
        );

        expect(byTestId(`wa-session-status-${session.ulid}`)?.textContent).toBe(
            'Scan the QR code',
        );
        expect(byTestId(`wa-session-qr-${session.ulid}`)).not.toBeNull();
    });

    it('troubleshoots a failed session: the last error and what to try', async () => {
        const webhook = makeWaSession({
            status: 'failed',
            lastError:
                'OpenWA refused the webhook address (it resolves to a private address).',
            webhookRegistered: false,
        });
        const down = makeWaSession({
            status: 'failed',
            lastError: 'OpenWA could not be reached: connection refused',
        });
        const missing = makeWaSession({
            status: 'ready',
            lastError: null,
            webhookRegistered: false,
        });

        await open({ sessions: [webhook, down, missing] });

        expect(
            byTestId(`wa-session-error-${webhook.ulid}`)?.textContent,
        ).toContain('private address');
        expect(
            byTestId(`wa-session-hint-${webhook.ulid}`)?.textContent,
        ).toContain('SSRF_ALLOWED_HOSTS');
        expect(byTestId(`wa-session-hint-${down.ulid}`)?.textContent).toContain(
            'could not be reached',
        );
        expect(
            byTestId(`wa-session-hint-${missing.ulid}`)?.textContent,
        ).toContain('no webhook');
    });

    it("changes one session's own sending limits, and only that session's", async () => {
        const session = ready();
        const other = makeWaSession({
            ulid: fakeUlid(5012),
            name: 'sales-line',
            status: 'ready',
        });

        await open({ sessions: [session, other] });

        expect(
            byTestId(`wa-session-limits-${session.ulid}`)?.textContent,
        ).toContain('At least 1.5 s between sends, 200 a day');

        await click(byTestId(`wa-session-pacing-${session.ulid}`));

        expect(byTestId('wa-pacing-dialog')?.textContent).toContain(
            'Sending limits of support-main',
        );
        // It starts on the global limits: the fields are not editable until the switch is off.
        expect(byTestId('wa-pacing-global')?.getAttribute('aria-checked')).toBe(
            'true',
        );
        expect(
            (byLabelText(dialog(), 'Daily limit') as HTMLInputElement).disabled,
        ).toBe(true);

        await click(byTestId('wa-pacing-global'));
        await fill(
            byLabelText(dialog(), 'Pause between messages') as HTMLInputElement,
            '4000',
        );
        await fill(
            byLabelText(dialog(), 'Daily limit') as HTMLInputElement,
            '50',
        );
        await click(byTestId('wa-pacing-save'));

        await waitFor(() =>
            expect(calls('PATCH', `/${session.ulid}`)).toHaveLength(1),
        );
        expect(calls('PATCH', `/${session.ulid}`)[0].body).toEqual({
            send_min_interval_ms: 4000,
            daily_send_cap: 50,
        });
        await waitFor(() => expect(byTestId('wa-pacing-dialog')).toBeNull());
        await waitFor(() =>
            expect(
                byTestId(`wa-session-limits-${session.ulid}`)?.textContent,
            ).toContain(
                'At least 4 s between sends, 50 a day · set for this session',
            ),
        );
        expect(
            byTestId(`wa-session-limits-${other.ulid}`)?.textContent,
        ).not.toContain('set for this session');
        expect(toast.success).toHaveBeenCalledWith(
            'The limits of support-main were saved.',
        );
    });

    it('goes back to the global limits with null for both', async () => {
        const session = {
            ...ready(),
            pacingOverridden: true,
            sendMinIntervalMs: 4000,
            dailySendCap: 50,
        };

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-pacing-${session.ulid}`));

        expect(byTestId('wa-pacing-global')?.getAttribute('aria-checked')).toBe(
            'false',
        );

        await click(byTestId('wa-pacing-global'));
        await click(byTestId('wa-pacing-save'));

        await waitFor(() =>
            expect(calls('PATCH', `/${session.ulid}`)).toHaveLength(1),
        );
        expect(calls('PATCH', `/${session.ulid}`)[0].body).toEqual({
            send_min_interval_ms: null,
            daily_send_cap: null,
        });
        await waitFor(() =>
            expect(
                byTestId(`wa-session-limits-${session.ulid}`)?.textContent,
            ).toContain('At least 1.5 s between sends, 200 a day'),
        );
        expect(
            byTestId(`wa-session-limits-${session.ulid}`)?.textContent,
        ).not.toContain('set for this session');
    });

    it("puts the server's validation message under the field and keeps the dialog open", async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-pacing-${session.ulid}`));
        await click(byTestId('wa-pacing-global'));

        // The field clamps what is typed to its range, so the 422 is provoked at the server instead.
        backend.server.use(
            http.patch(`/api/v1/whatsapp/sessions/${session.ulid}`, () =>
                HttpResponse.json(
                    {
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid.',
                            details: {
                                daily_send_cap: ['The limit is too high.'],
                            },
                        },
                    },
                    { status: 422 },
                ),
            ),
        );
        await click(byTestId('wa-pacing-save'));

        await waitFor(() =>
            expect(byTestId('wa-pacing-dialog')?.textContent).toContain(
                'The limit is too high.',
            ),
        );
        expect(byTestId('wa-pacing-dialog')).not.toBeNull();
    });

    it('shows the address OpenWA has to reach, as plain left-to-right text', async () => {
        const session = {
            ...ready(),
            webhookUrl: 'https://chat.example.com/webhooks/openwa/01ABC',
        };

        await open({ sessions: [session] });

        const url = byTestId(`wa-session-webhook-url-${session.ulid}`);

        expect(url?.textContent).toBe(
            'https://chat.example.com/webhooks/openwa/01ABC',
        );
        expect(url?.getAttribute('dir')).toBe('ltr');
    });

    it("shows OpenWA's refusal of the webhook address as the server words it, with the host to allow", async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5008),
            name: 'new-line',
            status: 'created',
            phone: null,
            maskedPhone: null,
        });
        const hint =
            'OpenWA refused http://app.test/webhooks/openwa/x. Put the host app.test into SSRF_ALLOWED_HOSTS on the OpenWA container.';

        await open({ sessions: [session] });
        backend.current.state.startError = {
            status: 422,
            code: 'webhook_rejected',
            message: hint,
        };
        await click(byTestId(`wa-session-start-${session.ulid}`));

        await waitFor(() =>
            expect(
                byTestId(`wa-session-problem-${session.ulid}`)?.textContent,
            ).toBe(hint),
        );
        // The QR dialog does not open for a session that did not start.
        expect(byTestId('wa-qr-dialog')).toBeNull();
        expect(byTestId(`wa-session-status-${session.ulid}`)?.textContent).toBe(
            'Not started',
        );
    });

    it('says when OpenWA has no webhook left for the session', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5009),
            status: 'created',
        });

        await open({ sessions: [session] });
        backend.current.state.startError = {
            status: 409,
            code: 'webhook_limit_reached',
            message: 'Limit.',
        };
        await click(byTestId(`wa-session-start-${session.ulid}`));

        await waitFor(() =>
            expect(
                byTestId(`wa-session-problem-${session.ulid}`)?.textContent,
            ).toContain('used up its webhooks'),
        );
    });

    it('re-registers the webhook only after a confirmation, and says it did', async () => {
        const session = ready();

        await open({ sessions: [session] });
        await click(byTestId(`wa-session-webhook-reregister-${session.ulid}`));

        expect(byTestId('wa-webhook-dialog')?.textContent).toContain(
            'Register the webhook of support-main again?',
        );
        expect(byTestId('wa-webhook-dialog')?.textContent).toContain(
            'new secret',
        );
        expect(calls('POST', `/${session.ulid}/webhook`)).toHaveLength(0);

        await click(byTestId('wa-webhook-dialog-confirm'));
        await waitFor(() =>
            expect(calls('POST', `/${session.ulid}/webhook`)).toHaveLength(1),
        );
        await waitFor(() => expect(byTestId('wa-webhook-dialog')).toBeNull());
        expect(toast.success).toHaveBeenCalledWith(
            'The webhook of support-main was registered again.',
        );
    });

    it('keeps the confirmation open with the reason when the re-registration fails', async () => {
        const session = ready();

        await open({ sessions: [session] });
        backend.current.state.webhookError = {
            status: 409,
            code: 'webhook_limit_reached',
            message: 'Limit.',
        };
        await click(byTestId(`wa-session-webhook-reregister-${session.ulid}`));
        await click(byTestId('wa-webhook-dialog-confirm'));

        await waitFor(() =>
            expect(byTestId('wa-webhook-dialog')?.textContent).toContain(
                'used up its webhooks',
            ),
        );
    });

    it('offers no webhook re-registration for a session that was never started', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5010),
            status: 'created',
        });

        await open({ sessions: [session] });

        expect(
            byTestId(`wa-session-webhook-reregister-${session.ulid}`),
        ).toBeNull();
    });

    it('keeps showing the code when the QR read is throttled (429), and says nothing is wrong', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5011),
            name: 'new-line',
            status: 'created',
            phone: null,
            maskedPhone: null,
        });

        await open({ sessions: [session] });
        backend.current.state.qr.set(session.ulid, PNG);
        await click(byTestId(`wa-session-start-${session.ulid}`));
        await waitFor(() => expect(byTestId('wa-qr-image')).not.toBeNull());

        backend.current.state.qrThrottled = 1;
        await click(byTestId('wa-qr-refresh'));

        await waitFor(() =>
            expect(
                calls('GET', `/${session.ulid}/qr`).length,
            ).toBeGreaterThanOrEqual(2),
        );
        expect(byTestId('wa-qr-image')?.getAttribute('src')).toBe(PNG);
        expect(byTestId('wa-qr-error')).toBeNull();
    });

    it('shows a failed action under the session it belongs to', async () => {
        const session = makeWaSession({
            ulid: fakeUlid(5007),
            status: 'created',
        });

        await open({ sessions: [session] });
        backend.current.state.forbidden = true;
        await click(byTestId(`wa-session-start-${session.ulid}`));

        await waitFor(() =>
            expect(
                byTestId(`wa-session-problem-${session.ulid}`),
            ).not.toBeNull(),
        );
    });
});

describe('hand-off and replies', () => {
    it('shows the saved values', async () => {
        await open({
            settings: { dailySendCap: 75, enabled: true, ignoreGroups: false },
        });

        expect(
            byTestId('wa-setting-enabled')?.getAttribute('aria-checked'),
        ).toBe('true');
        expect(
            byTestId('wa-setting-ignore-groups')?.getAttribute('aria-checked'),
        ).toBe('false');
        expect(input('wa-setting-handoff-text').value).toBe(
            'Hi! My support code is :code',
        );
        expect(
            (byTestId('wa-behavior-save') as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('previews the message with a sample code and the wa.me link of the connected number', async () => {
        const session = makeWaSession({
            status: 'ready',
            phone: '+49 170 1234567',
        });

        await open({ sessions: [session] });

        expect(byTestId('wa-handoff-message')?.textContent).toBe(
            'Hi! My support code is K7M2QX4P',
        );
        expect(byTestId('wa-handoff-link')?.textContent).toBe(
            'https://wa.me/491701234567?text=Hi!%20My%20support%20code%20is%20K7M2QX4P',
        );

        await fill(input('wa-setting-handoff-text'), 'Support :code please');
        expect(byTestId('wa-handoff-message')?.textContent).toBe(
            'Support K7M2QX4P please',
        );
    });

    it('says the link needs a connected session when there is none', async () => {
        await open({ sessions: [] });

        expect(byTestId('wa-handoff-no-number')).not.toBeNull();
        expect(byTestId('wa-handoff-link')).toBeNull();
    });

    it('refuses a hand-off message without :code before asking the server', async () => {
        await open();
        await fill(input('wa-setting-handoff-text'), 'Hello there');
        await click(byTestId('wa-behavior-save'));

        expect(byTestId('wa-behavior-form')?.textContent).toContain(
            'must contain :code',
        );
        expect(calls('PUT', '/whatsapp/settings')).toHaveLength(0);
    });

    it('saves only what changed', async () => {
        await open();
        await fill(input('wa-setting-handoff-text'), 'Support code :code');
        await click(byTestId('wa-setting-ignore-groups'));
        await click(byTestId('wa-behavior-save'));

        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')).toHaveLength(1),
        );
        expect(calls('PUT', '/whatsapp/settings')[0].body).toEqual({
            handoff_text: 'Support code :code',
            ignore_groups: false,
        });
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                'WhatsApp settings saved.',
            ),
        );
        // Saved: nothing left to save.
        await waitFor(() =>
            expect(
                (byTestId('wa-behavior-save') as HTMLButtonElement).disabled,
            ).toBe(true),
        );
    });

    it('turns the master switch on and off', async () => {
        await open({ settings: { enabled: false } });
        await click(byTestId('wa-setting-enabled'));
        await click(byTestId('wa-behavior-save'));

        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')[0]?.body).toEqual({
                enabled: true,
            }),
        );
    });

    it('warns loudly when replying to people who never wrote first is switched on', async () => {
        await open();

        expect(byTestId('wa-inbound-warning')).toBeNull();

        await click(byTestId('wa-setting-reply-inbound'));

        expect(byTestId('wa-inbound-warning')?.textContent).toContain('banned');
    });

    it('shows the code lifetime in words, and sends the largest photo in bytes', async () => {
        await open({
            settings: {
                handoffTtlMinutes: 1440,
                mediaMaxBytes: 5 * 1024 * 1024,
            },
        });

        expect(byTestId('wa-behavior-form')?.textContent).toContain('1 day');

        const media = byTestId(
            'wa-behavior-form',
        )?.querySelector<HTMLInputElement>(
            'input[type="number"][max="25"]',
        ) as HTMLInputElement;

        expect(media.value).toBe('5');

        await fill(media, '8');
        await click(byTestId('wa-behavior-save'));
        await waitFor(() =>
            expect(calls('PUT', '/whatsapp/settings')[0]?.body).toEqual({
                media_max_bytes: 8 * 1024 * 1024,
            }),
        );
    });

    it("puts the server's message under the field it is about", async () => {
        backend.server.use(
            http.put('/api/v1/whatsapp/settings', () =>
                HttpResponse.json(
                    {
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid.',
                            details: {
                                daily_send_cap: [
                                    'The daily send cap may not exceed 10000.',
                                ],
                            },
                        },
                    },
                    { status: 422 },
                ),
            ),
        );
        await open();
        await click(byTestId('wa-setting-ignore-groups'));
        await click(byTestId('wa-behavior-save'));

        await waitFor(() =>
            expect(byTestId('wa-behavior-form')?.textContent).toContain(
                'may not exceed 10000',
            ),
        );
        // A field error is not a general problem.
        expect(byTestId('wa-behavior-problem')).toBeNull();
    });

    it('says when saving fails for a reason that belongs to no field', async () => {
        backend.current.state.forbidden = true;
        await open();
        await click(byTestId('wa-setting-ignore-groups'));
        await click(byTestId('wa-behavior-save'));

        await waitFor(() =>
            expect(byTestId('wa-behavior-problem')).not.toBeNull(),
        );
    });
});
