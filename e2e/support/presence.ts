/**
 * Presence helpers for the P5 specs (docs/realtime.md, "Presence"): moving time for an agent's heartbeat in EITHER store, reading what the
 * store holds, and a controllable "is this tab visible" for the dashboard's heartbeat.
 *
 * Time moves by hand in this suite (no scheduler, `QUEUE_CONNECTION=sync`): `agePresenceRecord()` makes the stored timestamps older exactly as
 * real minutes would have, then a spec runs the sweep (`runSweep(instance, 'chat:presence-sweep')`) or just asks (`GET /me/presence` and
 * routing always compute the effective status at the moment they are asked).
 */
import { request, type Page } from '@playwright/test';
import { tinker } from './artisan';
import { hostOrigin } from './host';
import type { Instance } from './scenarios';

export type StoredPresence = {
    store: 'redis' | 'database';
    /** The status the agent chose (`online` | `away` | `offline`). */
    status: string;
    /** Pinned by the agent (`PUT` without `automatic`, or `away` / `offline`). */
    manual: boolean;
    /** Seconds since the last heartbeat / the last heartbeat of a VISIBLE tab / the last sign of life (null: never). */
    heartbeatAgo: number | null;
    visibleAgo: number | null;
    seenAgo: number | null;
    /** The status clients were last told (Redis `announced`, the mirror's `effective_status`). */
    announced: string | null;
    /** The effective status right now (what routing sees). */
    effective: string;
    /** Redis only: the remaining life of the record in seconds. */
    ttl: number | null;
};

/** The store that really answers: Redis for the Redis scenarios, the table otherwise (the failover scenario's Redis is unreachable on purpose). */
const storeOf = (instance: Instance): 'redis' | 'database' =>
    instance.redis === null ? 'database' : 'redis';

const AGE = `
$userId = (int) getenv('E2E_USER');
$ago = json_decode((string) getenv('E2E_AGO'), true);
$stamp = fn (?int $seconds) => $seconds === null ? null : now()->subSeconds($seconds);
if (getenv('E2E_STORE') === 'redis') {
    $redis = \\Illuminate\\Support\\Facades\\Redis::connection((string) config('presence.redis.connection', 'default'));
    $prefix = (string) config('presence.redis.prefix', 'presence:');
    if (! $redis->exists($prefix.$userId)) { throw new RuntimeException('No Redis presence record for user '.$userId); }
    foreach (['heartbeat' => 'last_heartbeat_at', 'visible' => 'last_visible_at', 'seen' => 'last_seen_at'] as $key => $field) {
        if (array_key_exists($key, $ago) && $ago[$key] !== null) { $redis->hset($prefix.$userId, $field, (string) $stamp($ago[$key])->getTimestamp()); }
    }
    if (array_key_exists('heartbeat', $ago) && $ago['heartbeat'] !== null) {
        $redis->zadd($prefix.'alive', $stamp($ago['heartbeat'])->getTimestamp(), (string) $userId);
    }
} else {
    $changes = [];
    foreach (['heartbeat' => 'last_heartbeat_at', 'visible' => 'last_visible_at', 'seen' => 'last_seen_at'] as $key => $column) {
        if (array_key_exists($key, $ago) && $ago[$key] !== null) { $changes[$column] = $stamp($ago[$key]); }
    }
    // (MySQL reports 0 changed rows when the values are the ones already stored: existence is checked on its own.)
    if (! \\DB::table('agent_presence')->where('user_id', $userId)->exists()) { throw new RuntimeException('No presence row for user '.$userId); }
    \\DB::table('agent_presence')->where('user_id', $userId)->update($changes);
}
`;

/**
 * Pretends the agent's last signs of life were `heartbeat` / `visible` / `seen` seconds ago (absolute: "this long ago", not "this much
 * older"; leave a field out to keep it). `heartbeat` also covers `seen` unless that is given: a heartbeat is a sign of life. Redis: the
 * hash fields and the `alive` score; database: the columns of the user's row. Throws when the user has no record.
 */
export async function agePresenceRecord(
    instance: Instance,
    userId: number,
    ago: { heartbeat?: number; visible?: number; seen?: number },
): Promise<void> {
    await tinker(instance, AGE, {
        E2E_STORE: storeOf(instance),
        E2E_USER: String(userId),
        E2E_AGO: JSON.stringify({
            heartbeat: ago.heartbeat ?? null,
            visible: ago.visible ?? null,
            seen: ago.seen ?? ago.heartbeat ?? null,
        }),
    });
}

const READ = `
$userId = (int) getenv('E2E_USER');
$service = app(\\App\\Domain\\Presence\\PresenceService::class);
$policy = \\App\\Domain\\Presence\\PresencePolicy::fromConfig();
$ago = fn ($value) => $value === null ? null : max(0, now()->getTimestamp() - $value->getTimestamp());
$out = ['store' => getenv('E2E_STORE'), 'ttl' => null];
if (getenv('E2E_STORE') === 'redis') {
    $redis = \\Illuminate\\Support\\Facades\\Redis::connection((string) config('presence.redis.connection', 'default'));
    $key = (string) config('presence.redis.prefix', 'presence:').$userId;
    $out['ttl'] = (int) $redis->ttl($key);
}
$record = app(\\App\\Domain\\Presence\\Contracts\\PresenceStore::class)->find($userId, now());
echo "\\nE2E_JSON=".json_encode($out + [
    'status' => $record?->status->value ?? 'offline',
    'manual' => $record?->manual ?? false,
    'heartbeatAgo' => $ago($record?->heartbeatAt),
    'visibleAgo' => $ago($record?->visibleAt),
    'seenAgo' => $ago($record?->seenAt),
    'announced' => $record?->announced?->value,
    'effective' => $policy->effective($record, now())->value,
])."\\n";
`;

/** What the presence store holds for one user right now (works for both stores; a user with no record reads as `offline`). */
export async function readPresenceRecord(
    instance: Instance,
    userId: number,
): Promise<StoredPresence> {
    const output = await tinker(instance, READ, {
        E2E_STORE: storeOf(instance),
        E2E_USER: String(userId),
    });
    const line = output.split('\n').find((row) => row.startsWith('E2E_JSON='));

    if (!line) {
        throw new Error(
            `Reading presence of ${userId} printed no JSON:\n${output}`,
        );
    }

    return JSON.parse(line.slice('E2E_JSON='.length)) as StoredPresence;
}

/**
 * Makes `document.visibilityState` / `document.hidden` / `document.hasFocus()` of the TOP document controllable from the spec (Playwright
 * pages are always visible and focused, even in the background). Call BEFORE the page loads (an init script); `setVisibility()` flips it and
 * fires `visibilitychange`, exactly what a browser does when the tab goes to the background or comes back.
 */
export async function installVisibilityControl(
    target:
        | Pick<Page, 'addInitScript'>
        | { addInitScript: Page['addInitScript'] },
): Promise<void> {
    await target.addInitScript(() => {
        if (window.top !== window) {
            return;
        }

        const state = { value: 'visible' as 'visible' | 'hidden' };
        const define = (name: string, get: () => unknown): void => {
            Object.defineProperty(document, name, {
                configurable: true,
                get,
            });
        };

        define('visibilityState', () => state.value);
        define('hidden', () => state.value === 'hidden');
        document.hasFocus = () => state.value === 'visible';
        (window as unknown as Record<string, unknown>).__pneSetVisibility = (
            next: 'visible' | 'hidden',
        ) => {
            state.value = next;
            document.dispatchEvent(new Event('visibilitychange'));
        };
    });
}

/** Sends the tab to the background (`hidden`) or back (`visible`); needs `installVisibilityControl()` before the page loaded. */
export async function setVisibility(
    page: Page,
    state: 'visible' | 'hidden',
): Promise<void> {
    await page.evaluate((next) => {
        const set = (window as unknown as Record<string, unknown>)
            .__pneSetVisibility as ((value: string) => void) | undefined;

        if (!set) {
            throw new Error(
                'installVisibilityControl() was not called before the page loaded.',
            );
        }

        set(next);
    }, state);
}

export type Heartbeat = { visible: boolean | null; at: number };

/**
 * Records every `POST /me/presence/heartbeat` the page sends (the body's `visible`). `list` is live; `count()` is a convenience for
 * `expect.poll`. Attach before the dashboard loads.
 */
export function recordHeartbeats(page: Page): {
    list: Heartbeat[];
    count: () => number;
    last: () => Heartbeat | undefined;
} {
    const list: Heartbeat[] = [];

    page.on('request', (request) => {
        if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/v1/me/presence/heartbeat'
        ) {
            let visible: boolean | null = null;

            try {
                const body = request.postDataJSON() as { visible?: boolean };

                visible =
                    typeof body.visible === 'boolean' ? body.visible : null;
            } catch {
                visible = null;
            }

            list.push({ visible, at: Date.now() });
        }
    });

    return {
        list,
        count: () => list.length,
        last: () => list[list.length - 1],
    };
}

export type Availability = {
    online: boolean;
    openNow: boolean;
    categories: { slug: string; online: boolean }[];
};

/**
 * The widget's PUBLIC availability (`GET /public/widgets/{key}/availability`, what the launcher and the panel read) as a visitor's browser on
 * the customer site would ask for it. `online` is true only while an agent the routing waves can offer a chat to is reachable.
 */
export async function widgetAvailability(
    instance: Instance,
    key: string,
): Promise<Availability> {
    const context = await request.newContext({
        baseURL: instance.url,
        extraHTTPHeaders: {
            Accept: 'application/json',
            Origin: hostOrigin(instance),
        },
    });

    try {
        const response = await context.get(
            `/api/v1/public/widgets/${key}/availability?t=${Date.now()}`,
        );

        if (!response.ok()) {
            throw new Error(
                `Availability of ${key}: HTTP ${response.status()}`,
            );
        }

        return ((await response.json()) as { data: Availability }).data;
    } finally {
        await context.dispose();
    }
}

const MIRROR = `
$row = \\DB::table('agent_presence')->where('user_id', (int) getenv('E2E_USER'))->first();
echo "\\nE2E_JSON=".json_encode($row)."\\n";
`;

/** The `agent_presence` row as stored (snake_case columns), or null: with the Redis store it is only a MIRROR, written when the effective status changes. */
export async function readMirrorRow(
    instance: Instance,
    userId: number,
): Promise<Record<string, any> | null> {
    const output = await tinker(instance, MIRROR, { E2E_USER: String(userId) });
    const line = output.split('\n').find((row) => row.startsWith('E2E_JSON='));

    if (!line) {
        throw new Error(
            `Reading the mirror of ${userId} printed no JSON:\n${output}`,
        );
    }

    return JSON.parse(line.slice('E2E_JSON='.length)) as Record<
        string,
        any
    > | null;
}

/**
 * Counts the websocket channel authorisations the page makes (`POST /broadcasting/auth`: one per channel the dashboard subscribes to:
 * the member's own `staff.{id}`, `presence-staff`, and `admin` for an administrator). An event the server publishes before a page has
 * subscribed is never replayed to it, so a spec that waits for "live" updates waits for these first. Attach before the page loads.
 */
export function watchChannelAuths(page: Page): { count: () => number } {
    let count = 0;

    page.on('response', (response) => {
        if (
            new URL(response.url()).pathname === '/broadcasting/auth' &&
            response.status() === 200
        ) {
            count += 1;
        }
    });

    return { count: () => count };
}
