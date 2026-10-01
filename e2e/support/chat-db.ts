/**
 * Time and the database for the chat specs. Nothing in this suite runs on a timer: there is no queue worker (`QUEUE_CONNECTION=sync`)
 * and no scheduler, so the deadlines of the product (queue timeout, idle timeout, rating window, routing waves) only matter when a
 * spec moves them with `ageConversation()` and then runs the sweep that acts on them with `runSweep()`, exactly what the per-minute
 * scheduler does in production. That keeps every spec deterministic and takes no waiting.
 *
 * The database is reached the way the rest of the suite does it (`artisan tinker` with the instance's environment, see `artisan.ts`);
 * `assertSafe` guarantees it is an e2e database. Each call boots the app (about a second): use it for state the APIs do not show
 * (close reason, ended-by, ratings, events, offers), not in loops.
 */
import { readFile } from 'node:fs/promises';
import { artisan, tinker } from './artisan';
import type { Instance } from './scenarios';

/** The sweeps the scheduler runs every minute (docs/rest-api.md, "Scheduled timers"). */
export type Sweep =
    | 'chat:expire-queued'
    | 'chat:close-idle'
    | 'chat:close-unrated'
    | 'chat:offer-waves'
    | 'chat:prune-visitor-sessions';

/** Any artisan command against the instance (its database, storage and Reverb environment); returns stdout. */
export const runArtisan = (
    instance: Instance,
    command: string,
    args: string[] = [],
): Promise<string> => artisan(instance, [command, ...args]);

/**
 * Runs one sweep now. `chat:expire-queued` marks queued chats past `queue_expires_at` as `missed`; `chat:close-idle` closes active chats
 * past `idle_expires_at` (`idle`); `chat:close-unrated` closes `ended` chats past `rating_window_expires_at` (`timeout`);
 * `chat:offer-waves` makes the routing waves that are due (the next wave of a queued chat, see `ageConversation({ by })`).
 */
export const runSweep = (instance: Instance, sweep: Sweep): Promise<string> =>
    runArtisan(instance, sweep);

export type Aging = {
    /**
     * Pretend this many seconds have already passed: moves `queued_at`, `queue_expires_at`, `idle_expires_at`,
     * `rating_window_expires_at` and the offers' `offered_at` / `expires_at` back by that much. With the seeded routing (second wave
     * at 20 s, queue timeout 45 s) `by: 25` makes the `away` wave due without expiring the queue; `by: 3600` makes everything past due.
     */
    by?: number;
    /** `queue_expires_at` one second in the past: `chat:expire-queued` marks the chat `missed`. */
    queueExpired?: boolean;
    /** `idle_expires_at` one second in the past: `chat:close-idle` closes the active chat (`idle`). */
    idleExpired?: boolean;
    /** `rating_window_expires_at` one second in the past: `chat:close-unrated` closes the ended chat (`timeout`), the rating is refused (`409 rating_window_closed`). */
    ratingWindowExpired?: boolean;
};

const AGE = `
$conversation = \\DB::table('conversations')->where('ulid', getenv('E2E_ULID'))->first();
if (! $conversation) { throw new RuntimeException('No conversation '.getenv('E2E_ULID')); }
$by = (int) getenv('E2E_BY');
$aging = json_decode((string) getenv('E2E_AGING'), true);
$back = fn ($value) => $value === null ? null : \\Illuminate\\Support\\Carbon::parse($value)->subSeconds($by);
$past = now()->subSecond();
$changes = [];
foreach (['queued_at', 'queue_expires_at', 'idle_expires_at', 'rating_window_expires_at'] as $column) {
    if ($by > 0 && $conversation->$column !== null) { $changes[$column] = $back($conversation->$column); }
}
if (! empty($aging['queueExpired'])) { $changes['queue_expires_at'] = $past; }
if (! empty($aging['idleExpired'])) { $changes['idle_expires_at'] = $past; }
if (! empty($aging['ratingWindowExpired'])) { $changes['rating_window_expires_at'] = $past; }
if ($changes !== []) { \\DB::table('conversations')->where('id', $conversation->id)->update($changes); }
if ($by > 0) {
    foreach (\\DB::table('conversation_agent_alerts')->where('conversation_id', $conversation->id)->get() as $offer) {
        \\DB::table('conversation_agent_alerts')->where('id', $offer->id)->update([
            'offered_at' => $back($offer->offered_at), 'expires_at' => $back($offer->expires_at),
        ]);
    }
}
`;

/** Moves a conversation's deadlines (see `Aging`); then run the sweep that acts on them. Throws when the conversation does not exist. */
export async function ageConversation(
    instance: Instance,
    ulid: string,
    aging: Aging,
): Promise<void> {
    await tinker(instance, AGE, {
        E2E_ULID: ulid,
        E2E_BY: String(aging.by ?? 0),
        E2E_AGING: JSON.stringify(aging),
    });
}

export type ConversationRow = {
    /** The `conversations` row as stored (snake_case): `status`, `close_reason`, `ended_by`, `wave`, `claim_version`, `queue_expires_at`, ... */
    conversation: Record<string, any>;
    /** The `ratings` row (`score`, `comment`), or null. */
    rating: { score: number; comment: string | null } | null;
    /** The audit trail, oldest first (`type`, `actor_type`, `actor_id`, `payload`). */
    events: {
        type: string;
        actor_type: string | null;
        actor_id: number | null;
        payload: any;
    }[];
    /** The offers (`user_id`, `wave`, `offered_at`, `expires_at`, `responded_at`, `response`). */
    offers: Record<string, any>[];
};

const READ = `
$conversation = \\DB::table('conversations')->where('ulid', getenv('E2E_ULID'))->first();
if (! $conversation) { throw new RuntimeException('No conversation '.getenv('E2E_ULID')); }
echo "\\nE2E_JSON=".json_encode([
    'conversation' => $conversation,
    'rating' => \\DB::table('ratings')->where('conversation_id', $conversation->id)->first(['score', 'comment']),
    'events' => \\DB::table('conversation_events')->where('conversation_id', $conversation->id)->orderBy('id')->get(['type', 'actor_type', 'actor_id', 'payload'])
        ->map(fn ($event) => array_merge((array) $event, ['payload' => json_decode((string) $event->payload, true)]))->all(),
    'offers' => \\DB::table('conversation_agent_alerts')->where('conversation_id', $conversation->id)->orderBy('id')
        ->get(['user_id', 'wave', 'offered_at', 'expires_at', 'responded_at', 'response'])->all(),
])."\\n";
`;

/**
 * What the APIs do not show: the stored row (`close_reason`, `ended_by`, `wave`, ...), the rating, the audit trail and the offers of one
 * conversation. For assertions such as "closed because it was rated 5": `row.conversation.status === 'closed'`,
 * `row.conversation.close_reason === 'rated'`, `row.rating.score === 5`.
 */
export async function readConversationRow(
    instance: Instance,
    ulid: string,
): Promise<ConversationRow> {
    const output = await tinker(instance, READ, { E2E_ULID: ulid });
    const line = output.split('\n').find((row) => row.startsWith('E2E_JSON='));

    if (!line) {
        throw new Error(
            `Reading conversation ${ulid} printed no JSON:\n${output}`,
        );
    }

    return JSON.parse(line.slice('E2E_JSON='.length)) as ConversationRow;
}

/**
 * What the `log` mailer wrote for this instance (`MAIL_MAILER=log`, the queue is `sync`, so a queued mail is "sent" inside the request
 * that caused it): the application log with the raw messages. `''` before anything was logged. Specs look for the subject, the
 * recipient and the body of the mail they provoked.
 */
export async function readMailLog(instance: Instance): Promise<string> {
    return readFile(`${instance.dir}/logs/laravel.log`, 'utf8').catch(() => '');
}

const AGE_SESSION = `
$hash = hash('sha256', (string) getenv('E2E_TOKEN'));
$session = \\DB::table('visitor_sessions')->where('token_hash', $hash)->first();
if (! $session) { throw new RuntimeException('No visitor session for that token'); }
$changes = getenv('E2E_MODE') === 'revoke' ? ['revoked_at' => now()] : ['expires_at' => now()->subSecond()];
\\DB::table('visitor_sessions')->where('id', $session->id)->update($changes);
`;

/**
 * Ends a visitor session behind the product's back: `expire` puts its expiry in the past (what the 60 s overlap after a token rotation
 * or the session lifetime do), `revoke` marks it revoked (a sign-out elsewhere). The token is then `401 session_revoked`.
 */
export async function endVisitorSession(
    instance: Instance,
    token: string,
    mode: 'expire' | 'revoke' = 'expire',
): Promise<void> {
    await tinker(instance, AGE_SESSION, { E2E_TOKEN: token, E2E_MODE: mode });
}
