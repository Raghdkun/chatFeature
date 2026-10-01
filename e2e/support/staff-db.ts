/**
 * Database-level setup the staff specs need and the APIs do not offer (same mechanism as `chat-db.ts`: `artisan tinker` against ONE
 * e2e instance, data through the environment, `assertSafe` refuses anything but a `chatfeature_e2e*` database). Each call boots the
 * app (about a second): use it for setup, not in loops.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tinker } from './artisan';
import type { Instance } from './scenarios';

const SET_SETTING = `
settings()->set((string) getenv('E2E_KEY'), json_decode((string) getenv('E2E_VALUE'), true));
settings()->forget();
`;

/**
 * Sets one setting (`chat.max_message_length`, ...) of the instance; the running server re-reads its settings within 2 s
 * (`SettingsRepository::MEMO_TTL_SECONDS`). Settings are global to the instance: restore the value in a `finally`.
 */
export async function setSetting(
    instance: Instance,
    key: string,
    value: unknown,
): Promise<void> {
    await tinker(instance, SET_SETTING, {
        E2E_KEY: key,
        E2E_VALUE: JSON.stringify(value),
    });
}

const SESSION_UPDATE = `
$session = \\App\\Models\\VisitorSession::query()->where('token_hash', hash('sha256', (string) getenv('E2E_TOKEN')))->first();
if (! $session) { throw new RuntimeException('No visitor session for that token'); }
$session->forceFill(json_decode((string) getenv('E2E_CHANGES'), true))->save();
`;

/** Expires a visitor's bearer token (`expires_at` a minute in the past): the next call is `401 session_revoked`. */
export async function expireVisitorToken(
    instance: Instance,
    token: string,
): Promise<void> {
    await tinker(instance, SESSION_UPDATE, {
        E2E_TOKEN: token,
        E2E_CHANGES: JSON.stringify({
            expires_at: new Date(Date.now() - 60_000)
                .toISOString()
                .replace('T', ' ')
                .slice(0, 19),
        }),
    });
}

/** Revokes a visitor's bearer token (`revoked_at` now). */
export async function revokeVisitorToken(
    instance: Instance,
    token: string,
): Promise<void> {
    await tinker(instance, SESSION_UPDATE, {
        E2E_TOKEN: token,
        E2E_CHANGES: JSON.stringify({
            revoked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        }),
    });
}

const SHIFT_DAYS = `
$conversation = \\DB::table('conversations')->where('ulid', getenv('E2E_ULID'))->first();
if (! $conversation) { throw new RuntimeException('No conversation '.getenv('E2E_ULID')); }
$days = (int) getenv('E2E_DAYS');
$upTo = (int) getenv('E2E_UP_TO_SEQ');
$move = fn ($value) => \\Illuminate\\Support\\Carbon::parse($value)->subDays($days);
if (getenv('E2E_CONVERSATION') === '1') {
    $changes = [];
    foreach (['created_at', 'queued_at', 'claimed_at', 'ended_at', 'closed_at', 'last_message_at'] as $column) {
        if ($conversation->$column !== null) { $changes[$column] = $move($conversation->$column); }
    }
    \\DB::table('conversations')->where('id', $conversation->id)->update($changes);
}
foreach (\\DB::table('messages')->where('conversation_id', $conversation->id)->where('seq', '<=', $upTo)->get() as $message) {
    \\DB::table('messages')->where('id', $message->id)->update(['created_at' => $move($message->created_at)]);
}
`;

/**
 * Moves the messages with `seq <= upToSeq` (default all) `days` days into the past (date separators in the transcript), and with
 * `conversation: true` the conversation's own timestamps too (the history page's date filters).
 */
export async function shiftConversationDays(
    instance: Instance,
    ulid: string,
    days: number,
    options: { upToSeq?: number; conversation?: boolean } = {},
): Promise<void> {
    await tinker(instance, SHIFT_DAYS, {
        E2E_ULID: ulid,
        E2E_DAYS: String(days),
        E2E_UP_TO_SEQ: String(options.upToSeq ?? 1_000_000),
        E2E_CONVERSATION: options.conversation ? '1' : '0',
    });
}

/** The instance's `laravel.log` (the log mailer writes every e-mail there: `MAIL_MAILER=log`). */
export async function readAppLog(instance: Instance): Promise<string> {
    try {
        return await readFile(`${instance.dir}/logs/laravel.log`, 'utf8');
    } catch {
        return '';
    }
}

/** sha256 of a token, as stored (`visitor_sessions.token_hash`). */
export const tokenHash = (token: string): string =>
    createHash('sha256').update(token).digest('hex');

const AGE_PRESENCE = `
$changes = ['last_heartbeat_at' => now()->subSeconds((int) getenv('E2E_SECONDS')), 'last_seen_at' => now()->subSeconds((int) getenv('E2E_SECONDS'))];
$updated = \\DB::table('agent_presence')->where('user_id', (int) getenv('E2E_USER'))->update($changes);
if ($updated !== 1) { throw new RuntimeException('No presence row for user '.getenv('E2E_USER')); }
`;

/**
 * Pretends the agent's last heartbeat was `seconds` ago (routing counts a heartbeat for 90 s: a closed tab drops out by itself).
 * The stored status stays as it is, so `online` + 120 s is "online, but nobody has heard from the browser".
 */
export async function agePresence(
    instance: Instance,
    userId: number,
    seconds: number,
): Promise<void> {
    await tinker(instance, AGE_PRESENCE, {
        E2E_USER: String(userId),
        E2E_SECONDS: String(seconds),
    });
}

const CREATE_ADMIN_AGENT = `
$user = \\App\\Models\\User::factory()->admin()->create([
    'name' => (string) getenv('E2E_NAME'), 'email' => (string) getenv('E2E_EMAIL'), 'password' => (string) getenv('E2E_PASSWORD'),
]);
echo "\\nE2E_ID=".$user->id."\\n";
`;

/**
 * An administrator who also takes chats (`is_admin` and `is_agent`), created straight in the database: the management API only creates
 * plain agents, and the seeded administrator is shared by every spec of the scenario (a spec that turns `is_agent` off must not use her).
 */
export async function createAdminAgent(
    instance: Instance,
    account: { name: string; email: string; password: string },
): Promise<number> {
    const output = await tinker(instance, CREATE_ADMIN_AGENT, {
        E2E_NAME: account.name,
        E2E_EMAIL: account.email,
        E2E_PASSWORD: account.password,
    });
    const line = output.split('\n').find((row) => row.startsWith('E2E_ID='));

    if (!line) {
        throw new Error(`Creating the administrator printed no id:\n${output}`);
    }

    return Number(line.slice('E2E_ID='.length));
}
