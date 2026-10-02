/**
 * Setting up a staff member's browser for the notification specs (P5): which permission it starts with and what the prompt answers, which
 * push subscription `pushManager.subscribe()` hands out, and a window onto what the page sent to the server. See push.ts for the stubs.
 *
 * The browser is a plain Playwright context of the staff actor; everything is installed BEFORE its first page loads (init scripts).
 */
import { createHash } from 'node:crypto';
import {
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect, type Page } from '@playwright/test';
import type { StaffActor } from './actors';
import { tinker } from './artisan';
import { must } from './chat-api';
import type { Instance } from './scenarios';
import {
    installPermissionStub,
    installPushStub,
    type FakeSubscription,
    type PermissionAnswer,
} from './push';
import { installVisibilityControl } from './presence';
import { expectEventually as baseEventually } from './wait';

export type NotifyBrowser = {
    /**
     * `Notification.permission` when the page loads (default `default`), as a SCRIPTED permission API. `real` leaves the browser's own
     * `Notification` alone (use `context.grantPermissions(['notifications'], { origin })`): what the real service worker needs to show anything.
     */
    permission?: NotificationPermission | 'real';
    /** What the browser's prompt answers when the app asks (default `granted`). */
    answer?: PermissionAnswer;
    /** The subscription `pushManager.subscribe()` returns (a refused-connection one by default: `FakeSubscription.dead()`). */
    subscription?: FakeSubscription | null;
    /** Make `document.visibilityState` controllable (see presence.ts). */
    visibility?: boolean;
    /** Take push support away: no `PushManager` (an old browser), or no service worker. */
    without?: 'push-manager' | 'service-worker';
};

/** Installs the stubs on a staff actor's context. Call before the actor's first navigation. */
export async function prepareBrowser(
    actor: StaffActor,
    options: NotifyBrowser = {},
): Promise<void> {
    if (options.permission !== 'real') {
        await installPermissionStub(actor.context, {
            initial: options.permission ?? 'default',
            answer: options.answer ?? 'granted',
        });
    }

    await installPushStub(actor.context, null);

    if (options.subscription !== null && options.subscription !== undefined) {
        const subscription = options.subscription;

        await actor.context.addInitScript((next) => {
            (
                window as unknown as { __nextSubscription?: unknown }
            ).__nextSubscription = next;
        }, subscription.toJSON());
    }

    if (options.visibility) {
        await installVisibilityControl(actor.context);
    }

    if (options.without === 'push-manager') {
        await actor.context.addInitScript(() => {
            delete (window as unknown as Record<string, unknown>).PushManager;
        });
    }

    if (options.without === 'service-worker') {
        await actor.context.addInitScript(() => {
            // A browser without service workers has no `navigator.serviceWorker` at all (the property is not merely empty).
            delete (Navigator.prototype as unknown as Record<string, unknown>)
                .serviceWorker;
        });
    }
}

export type SubscriptionPost = { status: number; body: any; at: number };

/** Records the browser's `POST /api/v1/me/push-subscriptions` calls (status and body). Attach before the dashboard loads. */
export function recordSubscriptionPosts(page: Page): {
    list: SubscriptionPost[];
    count: () => number;
} {
    const list: SubscriptionPost[] = [];

    page.on('response', (response) => {
        const request = response.request();

        if (
            request.method() === 'POST' &&
            new URL(response.url()).pathname === '/api/v1/me/push-subscriptions'
        ) {
            let body: unknown = null;

            try {
                body = request.postDataJSON();
            } catch {
                body = null;
            }

            list.push({ status: response.status(), body, at: Date.now() });
        }
    });

    return { list, count: () => list.length };
}

const SETTING_ROW = `
$changes = json_decode((string) getenv('E2E_CHANGES'), true);
foreach ($changes as $column => $value) {
    if (is_string($value) && str_starts_with($value, 'now:')) { $changes[$column] = now()->modify(substr($value, 4)); }
}
\\App\\Models\\NotificationSetting::query()->updateOrCreate(['user_id' => (int) getenv('E2E_USER')], $changes);
`;

/**
 * Sets columns of a member's `notification_settings` row directly (what the API cannot do: a snooze that has run out). A value
 * `now:<modifier>` becomes `now()->modify(<modifier>)` (`now:-1 minute`).
 */
export async function setNotificationRow(
    instance: Instance,
    userId: number,
    changes: Record<string, string | number | boolean | null>,
): Promise<void> {
    await tinker(instance, SETTING_ROW, {
        E2E_USER: String(userId),
        E2E_CHANGES: JSON.stringify(changes),
    });
}

/** The member's notification settings as the API says (`GET /me/notification-settings`), camelCase. */
export async function notificationSettings(actor: StaffActor): Promise<{
    sound: boolean;
    pushOffers: boolean;
    pushMessages: boolean;
    includePreview: boolean;
    quietHours: {
        enabled: boolean;
        start: string;
        end: string;
        timezone: string;
    };
    promptState: 'never' | 'granted' | 'denied' | 'snoozed';
    promptedAt: string | null;
    snoozedUntil: string | null;
    previewsAllowed: boolean;
    pushAvailable: boolean;
    snoozeDays: number;
}> {
    return must(
        await actor.api.api.get('/api/v1/me/notification-settings'),
        'notification settings',
    );
}

/** The browsers registered for push (`GET /me/push-subscriptions`). */
export async function pushDevices(actor: StaffActor): Promise<
    {
        id: string;
        label: string;
        host: string;
        endpointHash: string;
        createdAt: string | null;
        lastUsedAt: string | null;
    }[]
> {
    return must(
        await actor.api.api.get('/api/v1/me/push-subscriptions'),
        'push devices',
    );
}

/** sha-256 of an endpoint, as the server and the settings page identify "this device". */
export const endpointHash = (endpoint: string): string =>
    createHash('sha256').update(endpoint).digest('hex');

/**
 * Starts watching for the answer of `GET /me/push-subscriptions`, which the dashboard's notification controller asks for once its settings
 * are loaded and BEFORE it decides about the first-login dialog (so the answer means the decision was taken). Call it before the page loads,
 * hand the result to `passPromptDelay()` after.
 */
export function watchControllerStart(page: Page): Promise<unknown> {
    return page
        .waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    '/api/v1/me/push-subscriptions' &&
                response.request().method() === 'GET',
            { timeout: 30_000 },
        )
        .catch(() => null);
}

/**
 * Moves the page clock past the first-login dialog's 1.5 s delay once the controller has started: after this a dialog that is going to open
 * HAS opened, so "it is not there" is a real assertion. The page must have a fake clock (`page.clock.install()` before it loaded).
 */
export async function passPromptDelay(
    page: Page,
    started: Promise<unknown>,
): Promise<void> {
    await started;
    await page.clock.fastForward(3_000);
}

const COUNT_SUBSCRIPTIONS = `
echo "\\nE2E_COUNT=".\\App\\Models\\PushSubscription::query()->where('user_id', (int) getenv('E2E_USER'))->count()."\\n";
`;

/** How many push subscriptions the server holds for a user (the API only answers to that user's own session). */
export async function countSubscriptions(
    instance: Instance,
    userId: number,
): Promise<number> {
    const output = await tinker(instance, COUNT_SUBSCRIPTIONS, {
        E2E_USER: String(userId),
    });
    const line = output.split('\n').find((row) => row.startsWith('E2E_COUNT='));

    if (!line) {
        throw new Error(`Counting subscriptions printed nothing:\n${output}`);
    }

    return Number(line.slice('E2E_COUNT='.length));
}

const CENTRE_LOCK = join(tmpdir(), 'chatfeature-e2e-notification-centre.lock');
const CENTRE_STALE_MS = 5 * 60_000;

/**
 * Browsers share one place that shows notifications (on macOS the system's notification centre, which every Chrome process of this machine
 * writes to and the ids of which are made of the origin and the tag, not of the process): a notification one Chrome shows can vanish when
 * another Chrome closes or replaces its namesake, and `registration.getNotifications()` then says `[]` although the worker's
 * `showNotification()` resolved (seen as 1 test in 7 with four workers running the worker specs side by side). Specs that look at what the
 * browser DISPLAYS therefore take this machine-wide lock for the length of the test, so only one Chrome at a time shows notifications. Waits for
 * the holder; a lock whose holder is gone (or older than five minutes) is taken over. Returns the release function.
 */
export async function takeNotificationCentre(
    timeoutMs = 540_000,
): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            mkdirSync(CENTRE_LOCK);
            writeFileSync(join(CENTRE_LOCK, 'pid'), String(process.pid));

            return () => rmSync(CENTRE_LOCK, { recursive: true, force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }

        if (centreIsAbandoned()) {
            rmSync(CENTRE_LOCK, { recursive: true, force: true });

            continue;
        }

        if (Date.now() > deadline) {
            throw new Error(
                `The notification centre stayed taken for ${timeoutMs} ms (${CENTRE_LOCK}).`,
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}

function centreIsAbandoned(): boolean {
    try {
        if (Date.now() - statSync(CENTRE_LOCK).mtimeMs > CENTRE_STALE_MS) {
            return true;
        }

        const pid = Number(readFileSync(join(CENTRE_LOCK, 'pid'), 'utf8'));

        if (!Number.isInteger(pid) || pid <= 0) {
            return false;
        }

        try {
            process.kill(pid, 0);

            return false;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
    } catch {
        // The directory is being created (no pid file yet) or was just released: look again.
        return false;
    }
}

/**
 * Registering a push subscription and every push look the endpoint's host up in DNS (the product only accepts public hosts), and on a
 * machine whose resolver is a VPN that lookup takes about 300 ms and now and then stalls for seconds (found: 2 runs of 100). What a spec waits
 * for after such a step gets this much time instead of the suite's ten seconds; `E2E_PUSH_HOST=<public IPv4>` takes DNS out of it altogether.
 */
export const DNS_BOUND_MS = 45_000;

/** Playwright's `expect` with the time a DNS-bound step needs. */
export const expect = baseExpect.configure({ timeout: DNS_BOUND_MS });

/** `expectEventually` with the time a DNS-bound step needs (an explicit `timeout` still wins). */
export const expectEventually: typeof baseEventually = (read, until, options) =>
    baseEventually(read, until, { timeout: DNS_BOUND_MS, ...options });
