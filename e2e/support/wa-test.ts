/**
 * The `test` of the WhatsApp specs (`e2e/whatsapp/*`, P6): `../support/test` plus the machinery that lets many spec files share ONE app, ONE
 * Reverb and ONE OpenWA mock per project without disturbing each other.
 *
 *   import { expect, test } from '../support/wa-test';
 *   test.use({ scenario: 'p6-wa' });
 *
 *   test('...', async ({ wa, openWa }) => {                       // `shared` (default): own session, own numbers, own widget
 *       const session = await readySession(wa, openWa);
 *       ...
 *   });
 *
 *   test.describe('...', () => {
 *       test.use({ waMode: 'exclusive' });                        // alone in the instance: global settings, mock config / scripts, totals
 *       ...
 *   });
 *
 * - `waMode: 'shared'` (default): the test takes the SHARED side of the instance lock (`wa-lock.ts`); it must only touch what it created
 *   (a session with its own name and number, its own widget, chats found by their number).
 * - `waMode: 'exclusive'`: the test runs alone. The mock is reset (sessions, scripts, config back to the CLI defaults) and the `whatsapp.*`
 *   behaviour settings are put back to their defaults before it starts (and after it ends, so the next shared test finds the usual state).
 *   `waWipe: true` additionally deletes every WhatsApp row of the app (sessions for good, with their chats, messages, tickets, deliveries and
 *   send counters) and unlinks every widget, for tests that count sessions or chats or look at the sidebar total.
 *
 * The instance memoises settings for 2 s per PHP worker (`SettingsRepository::MEMO_TTL_SECONDS`, the app runs with four workers): after a
 * settings write the helpers below wait that long once, and so should a spec that writes settings itself (`settleSettings()`).
 */
import { test as base, expect } from './test';
import { tinker } from './artisan';
import type { OpenWaMock } from './openwa';
import type { Instance } from './scenarios';
import { acquireScenarioLock } from './wa-lock';
import {
    data,
    eventually,
    WaAdminApi,
    type WaChat,
    type WaMessage,
    type WaSession,
} from './whatsapp';

export { expect };

/** The behaviour settings and their defaults (`docs/contracts/whatsapp-data-p6.md`), in the request spelling of `PUT /whatsapp/settings`. */
export const SETTING_DEFAULTS = {
    enabled: true,
    handoff_ttl_minutes: 1440,
    handoff_text: 'Hi! My support code is :code',
    ignore_groups: true,
    reply_only_to_inbound: true,
    send_min_interval_ms: 1500,
    daily_send_cap: 200,
    media_max_bytes: 5 * 1024 * 1024,
} as const;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A settings write reaches the other PHP workers within `MEMO_TTL_SECONDS` (2 s): wait it out once (a documented design constant, not a guess). */
export const settleSettings = () => sleep(2_200);

/** Puts the behaviour settings back to their defaults (only when something differs) and waits for the workers to notice. */
export async function restoreSettings(wa: WaAdminApi): Promise<void> {
    const current = data<Record<string, unknown>>(
        await wa.settings(),
        'read the settings',
    );
    const camel = {
        enabled: current.enabled,
        handoff_ttl_minutes: current.handoffTtlMinutes,
        handoff_text: current.handoffText,
        ignore_groups: current.ignoreGroups,
        reply_only_to_inbound: current.replyOnlyToInbound,
        send_min_interval_ms: current.sendMinIntervalMs,
        daily_send_cap: current.dailySendCap,
        media_max_bytes: current.mediaMaxBytes,
    } as Record<string, unknown>;
    const changed = Object.fromEntries(
        Object.entries(SETTING_DEFAULTS).filter(
            ([key, value]) => camel[key] !== value,
        ),
    );

    if (Object.keys(changed).length === 0) {
        return;
    }

    data(await wa.saveSettings(changed), 'restore the settings');
    await settleSettings();
}

/** What the connection card changes: the address and key of OpenWA, back to the instance's mock. */
export async function restoreConnection(
    wa: WaAdminApi,
    openWa: OpenWaMock,
): Promise<void> {
    data(
        await wa.saveSettings({ base_url: openWa.url, api_key: openWa.apiKey }),
        'restore the OpenWA connection',
    );
    await settleSettings();
}

const WIPE = `
use App\\Models\\WhatsAppSession;
use App\\Models\\Widget;
Widget::query()->whereNotNull('whatsapp_session_id')->update(['whatsapp_session_id' => null]);
WhatsAppSession::withTrashed()->get()->each(fn ($session) => $session->forceDelete());
echo "E2E_WIPED=".WhatsAppSession::withTrashed()->count()."\\n";
`;

/** Deletes every WhatsApp row of the instance and unlinks every widget (a clean slate for a test that counts). */
export async function wipeWhatsApp(instance: Instance): Promise<void> {
    const output = await tinker(instance, WIPE);

    if (!output.includes('E2E_WIPED=0')) {
        throw new Error(`Wiping WhatsApp data failed:\n${output}`);
    }
}

type Options = {
    waMode: 'shared' | 'exclusive';
    waWipe: boolean;
};

type Fixtures = {
    /** The WhatsApp management API as the saved administrator. */
    wa: WaAdminApi;
    waGuard: void;
};

export const test = base.extend<Options & Fixtures>({
    waMode: ['shared', { option: true }],
    waWipe: [false, { option: true }],

    wa: async ({ adminApi }, use) => {
        await use(new WaAdminApi(adminApi));
    },

    waGuard: [
        async ({ instance, openWa, wa, waMode, waWipe }, use) => {
            const release = await acquireScenarioLock(instance, waMode);

            try {
                if (waMode === 'exclusive') {
                    await openWa.reset();
                    await restoreSettings(wa);

                    if (waWipe) {
                        await wipeWhatsApp(instance);
                    }
                }

                await use();
            } finally {
                try {
                    if (waMode === 'exclusive') {
                        await openWa.reset();
                        await restoreSettings(wa);
                    }
                } finally {
                    release();
                }
            }
        },
        // Waiting for the lock is not the test's time: a queue of exclusive tests ahead of this one can take minutes.
        { auto: true, timeout: 15 * 60_000 },
    ],
});

// ------------------------------------------------------------------------------------------------------------------------------
// Names and numbers

let serial = 0;

/** A name nothing else in the run has used (session names: letters, digits, hyphens, 3-50 characters). */
export function uniqueName(prefix = 'wa'): string {
    serial += 1;

    return `${prefix}-${Date.now().toString(36)}${serial.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
}

/**
 * A customer number (digits only, as the mock's `from` takes it) that no other test uses: the process, a counter that never repeats within it
 * and the clock (E.164 allows 15 digits: a 4-digit prefix and 11 of these).
 */
export function uniquePhone(prefix = '4915'): string {
    serial += 1;

    const worker = String(process.pid % 100).padStart(2, '0');
    const count = String(serial % 1000).padStart(3, '0');
    const clock = String(Date.now() % 1_000_000).padStart(6, '0');

    return `${prefix}${worker}${count}${clock}`;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Sessions and chats through the real API and the mock

export type TestSession = {
    ulid: string;
    name: string;
    /** The number of the connected phone (digits). */
    phone: string;
};

/**
 * A `ready` session the way an administrator gets one: created, started (the app registers the webhook, the mock answers `qr_ready`), the phone
 * scans (the mock says `ready`). The session gets its own pacing (no minimum interval, the global daily cap) so replies are not slowed down.
 */
export async function readySession(
    wa: WaAdminApi,
    openWa: OpenWaMock,
    options: {
        name?: string;
        phone?: string;
        /** The session's own minimum interval between sends in ms (default 0: no wait). */
        interval?: number;
        /** The session's own daily cap. */
        cap?: number;
    } = {},
): Promise<TestSession> {
    const name = options.name ?? uniqueName('s');
    const phone = options.phone ?? uniquePhone('4916');
    const created = data<WaSession>(
        await wa.createSession(name),
        'create the session',
    );

    data(
        await wa.updateSession(created.ulid, {
            send_min_interval_ms: options.interval ?? 0,
            ...(options.cap === undefined
                ? {}
                : { daily_send_cap: options.cap }),
        }),
        'set the session pacing',
    );

    const started = await wa.startSession(created.ulid);

    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await openWa.waitForSession(name);
    await openWa.connect(name, phone, 'PNE Support');
    await eventually(async () => {
        const session = data<WaSession>(
            await wa.session(created.ulid),
            'read the session',
        );

        return session.status === 'ready' ? session : undefined;
    }, `session ${name} to become ready`);

    return { ulid: created.ulid, name, phone };
}

/** A chat of the session with this customer number, once the app has recorded their first message. */
export function waitForChat(
    wa: WaAdminApi,
    session: Pick<TestSession, 'ulid'>,
    customer: string,
    filters: Record<string, string> = {},
): Promise<WaChat> {
    return eventually(async () => {
        const rows = data<WaChat[]>(
            await wa.chats({
                session: session.ulid,
                q: customer,
                status: 'all',
                ...filters,
            }),
            'list the chats',
        );

        // The chat row is created a moment before its first message and counters are committed: a snapshot in between has no
        // `lastMessageAt` yet (and `unreadByAdmin` 0), so wait for the first message.
        return rows.find(
            (row) =>
                row.phone?.replace(/\D/g, '') === customer &&
                row.lastMessageAt !== null,
        );
    }, `the chat of ${customer}`);
}

/** The transcript of a chat, oldest first. */
export async function transcript(
    wa: WaAdminApi,
    chat: Pick<WaChat, 'ulid'>,
): Promise<WaMessage[]> {
    return data<WaMessage[]>(
        await wa.messages(chat.ulid),
        'read the transcript',
    );
}

/** Polls the transcript until a message satisfies `match`. */
export function waitForMessage(
    wa: WaAdminApi,
    chat: Pick<WaChat, 'ulid'>,
    match: (message: WaMessage) => boolean,
    what = 'a message of the transcript',
): Promise<WaMessage> {
    return eventually(
        async () => (await transcript(wa, chat)).find(match),
        what,
    );
}
