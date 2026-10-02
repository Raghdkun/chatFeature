#!/usr/bin/env node
/**
 * Real-socket proof of the stale-socket cut-off (P7, docs/realtime.md "Cutting a socket off"). NOT part of `composer test`,
 * `npm test` or Playwright: run it by hand,
 *
 *     node e2e/support/realtime-cutoff-smoke.mjs
 *
 * It starts `php artisan reverb:start` and a PHP web server, seeds rows into the database of this checkout (and removes them again),
 * opens real websockets with `pusher-js` (the library the browser clients use) as a visitor, agents and an administrator, changes the
 * state from a second PHP process (demotion, transfer, deactivation, a revoked / rotated / expired visitor token) and checks what the
 * wire does: the revoked actor's socket is CLOSED, the client reconnects and is refused the channel it lost (and keeps the ones it
 * still may have), nothing else is disturbed, and a call that cannot reach Reverb is parked and worked off later.
 *
 * Needs: a migrated MySQL database whose name starts with `chatfeature_p7_`, `chatfeature_p4_`, `chatfeature_rt` or `chatfeature_e2e`
 * (never the shared dev database). Redis is not needed: queue `sync`, cache and sessions use files.
 * Ports (override with CUTOFF_SMOKE_WEB_PORT / CUTOFF_SMOKE_REVERB_PORT): web 8312, Reverb 8316.
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Pusher = require('pusher-js');

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_PORT = Number(process.env.CUTOFF_SMOKE_WEB_PORT ?? 8312);
const REVERB_PORT = Number(process.env.CUTOFF_SMOKE_REVERB_PORT ?? 8316);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const KEY = 'cutoff-smoke-key';
const RUN = Math.random().toString(36).slice(2, 8);

const PHP_ENV = {
    ...process.env,
    APP_ENV: 'local',
    APP_DEBUG: 'false',
    APP_URL: WEB,
    APP_INSTALLED: 'true',
    BROADCAST_CONNECTION: 'reverb',
    QUEUE_CONNECTION: 'sync',
    CACHE_STORE: 'file',
    SESSION_DRIVER: 'file',
    REVERB_APP_ID: '1002',
    REVERB_APP_KEY: KEY,
    REVERB_APP_SECRET: 'cutoff-smoke-secret',
    REVERB_HOST: '127.0.0.1',
    REVERB_PORT: String(REVERB_PORT),
    REVERB_SCHEME: 'http',
    REVERB_SERVER_HOST: '127.0.0.1',
    REVERB_SERVER_PORT: String(REVERB_PORT),
    PHP_CLI_SERVER_WORKERS: '4',
};

const results = [];
const children = [];
const logs = [];
const timings = [];

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
    );
}

async function check(name, run) {
    try {
        const detail = await run();
        record(name, true, typeof detail === 'string' ? detail : '');
    } catch (error) {
        record(
            name,
            false,
            error instanceof Error ? error.message : String(error),
        );
    }
}

function expect(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- safety / processes --------------------------------------------------------------------

function assertSafeDatabase() {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const match = /^DB_DATABASE=(.*)$/m.exec(env);
    const name = (process.env.DB_DATABASE ?? match?.[1] ?? '').replaceAll('"', '');

    if (!/^chatfeature_(p7_|p4_|rt|e2e)/.test(name)) {
        throw new Error(
            `Refusing to seed into database "${name}": use a dedicated chatfeature_p7_* / p4_* / rt* / e2e* database.`,
        );
    }

    return name;
}

async function php(code, data = {}) {
    const env = { ...PHP_ENV, SMOKE: JSON.stringify(data) };
    const { stdout } = await execFileAsync(
        'php',
        ['artisan', 'tinker', '--execute', code, '--no-interaction'],
        { cwd: ROOT, env, timeout: 120_000, maxBuffer: 8_000_000 },
    );
    const line = stdout.split('\n').find((row) => row.startsWith('JSON:'));

    return line === undefined ? null : JSON.parse(line.slice(5));
}

async function artisan(...args) {
    const { stdout } = await execFileAsync('php', ['artisan', ...args], {
        cwd: ROOT,
        env: PHP_ENV,
        timeout: 120_000,
    });

    return stdout.trim();
}

function start(name, command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd ?? ROOT,
        env: PHP_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    const keep = (chunk) => {
        logs.push(`[${name}] ${chunk.toString().trimEnd()}`);

        if (logs.length > 400) {
            logs.shift();
        }
    };

    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    children.push(child);

    return child;
}

function waitForPort(port, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((done, fail) => {
        const attempt = () => {
            const socket = net.connect(port, '127.0.0.1');

            socket.once('connect', () => {
                socket.destroy();
                done();
            });
            socket.once('error', () => {
                socket.destroy();

                if (Date.now() > deadline) {
                    fail(new Error(`port ${port} did not open`));
                } else {
                    setTimeout(attempt, 200);
                }
            });
        };

        attempt();
    });
}

function stopAll() {
    for (const child of children) {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            // already gone
        }
    }
}

// ---- Pusher clients ------------------------------------------------------------------------

const WebSocketClient = Pusher.Runtime.getWebSocketAPI();
Pusher.Runtime.createWebSocket = (url) =>
    new WebSocketClient(url, [], { headers: { Origin: WEB } });

const staffAuth = (token) => ({
    endpoint: `${WEB}/broadcasting/auth`,
    headers: { Authorization: `Bearer ${token}` },
});
const visitorAuth = (tokenOf) => ({
    endpoint: `${WEB}/api/v1/public/broadcasting/auth`,
    headers: () => ({ Authorization: `Bearer ${tokenOf()}` }),
});

/** A pusher-js client; `authOf` may hold a function for the headers so a client can change its token (a reconnect uses the newest). */
async function connect(auth, label) {
    const pusher = new Pusher(KEY, {
        cluster: 'mt1',
        wsHost: '127.0.0.1',
        wsPort: REVERB_PORT,
        forceTLS: false,
        enabledTransports: ['ws'],
        disableStats: true,
        channelAuthorization: {
            transport: 'ajax',
            endpoint: auth.endpoint,
            customHandler: ({ socketId, channelName }, callback) => {
                const headers =
                    typeof auth.headers === 'function'
                        ? auth.headers()
                        : auth.headers;

                fetch(auth.endpoint, {
                    method: 'POST',
                    headers: {
                        ...headers,
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        socket_id: socketId,
                        channel_name: channelName,
                    }),
                })
                    .then(async (response) => {
                        if (!response.ok) {
                            callback(new Error(`auth ${response.status}`), null);

                            return;
                        }

                        // exactly what pusher-js hands the subscribe frame: `auth` and `channel_data`
                        callback(null, await response.json());
                    })
                    .catch((error) => callback(error, null));
            },
        },
    });

    pusher.label = label;
    pusher.history = [];
    pusher.connection.bind('state_change', ({ previous, current }) =>
        pusher.history.push({ previous, current, at: Date.now() }),
    );

    await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('connect timeout')), 8000);

        pusher.connection.bind('connected', () => {
            clearTimeout(timer);
            done();
        });
    });

    return pusher;
}

/** Resolves with the time (epoch ms) at which the client's socket left the `connected` state. Create BEFORE triggering the cut. */
function closedAt(pusher, timeoutMs = 8000) {
    return new Promise((done, fail) => {
        const timer = setTimeout(
            () => fail(new Error(`${pusher.label}: socket was NOT closed within ${timeoutMs} ms`)),
            timeoutMs,
        );
        const onChange = ({ previous }) => {
            if (previous === 'connected') {
                clearTimeout(timer);
                pusher.connection.unbind('state_change', onChange);
                done(Date.now());
            }
        };

        pusher.connection.bind('state_change', onChange);
    });
}

function connectedAgain(pusher, timeoutMs = 20_000) {
    return new Promise((done, fail) => {
        const timer = setTimeout(
            () => fail(new Error(`${pusher.label}: did not reconnect`)),
            timeoutMs,
        );
        const poll = setInterval(() => {
            if (pusher.connection.state === 'connected') {
                clearTimeout(timer);
                clearInterval(poll);
                done();
            }
        }, 100);
    });
}

function subscribe(pusher, name, expectRefusal = false) {
    return new Promise((done, fail) => {
        const channel = pusher.subscribe(name);
        const timer = setTimeout(
            () => fail(new Error(`subscribe ${name}: timeout`)),
            6000,
        );

        channel.bind('pusher:subscription_succeeded', () => {
            clearTimeout(timer);
            expectRefusal
                ? fail(new Error(`${name} was NOT refused`))
                : done(channel);
        });
        channel.bind('pusher:subscription_error', (error) => {
            clearTimeout(timer);
            expectRefusal
                ? done(error?.status ?? error)
                : fail(new Error(`subscribe ${name}: refused (${error?.status ?? JSON.stringify(error)})`));
        });
    });
}

/** Collects the events of a channel; `next(event)` awaits one that arrives (or already arrived). */
function inbox(channel) {
    const received = [];
    const waiters = [];

    channel.bind_global((event, data) => {
        if (event.startsWith('pusher')) {
            return;
        }

        received.push({ event, data, at: Date.now() });

        for (const waiter of waiters.filter((entry) => entry.event === event)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            received.splice(received.findIndex((entry) => entry.event === event), 1);
            waiter.done(data);
        }
    });

    return {
        received,
        next(event, timeoutMs = 6000) {
            const earlier = received.findIndex((entry) => entry.event === event);

            if (earlier >= 0) {
                return Promise.resolve(received.splice(earlier, 1)[0].data);
            }

            return new Promise((done, fail) => {
                const waiter = { event, done };

                waiters.push(waiter);
                setTimeout(() => {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    fail(new Error(`no "${event}" within ${timeoutMs} ms`));
                }, timeoutMs);
            });
        },
        has: (event) => received.some((entry) => entry.event === event),
    };
}

// ---- fixtures ------------------------------------------------------------------------------

const SEED = String.raw`
use App\Models\{User, Widget, Visitor, Category, Conversation, AgentPresence};
use App\Domain\Visitors\VisitorTokenService;
$run = json_decode(getenv('SMOKE'), true)['run'];
settings()->set('auth.mode', 'fortify');
$adminAgent = User::factory()->admin()->create(['name' => 'Smoke Admin', 'email' => "co-admin-$run@smoke.test", 'is_agent' => true]);
$agent = User::factory()->agent()->create(['name' => 'Smoke Agent A', 'display_name' => 'Alex', 'email' => "co-a-$run@smoke.test", 'max_concurrent_chats' => 5]);
$colleague = User::factory()->agent()->create(['name' => 'Smoke Agent B', 'display_name' => 'Bea', 'email' => "co-b-$run@smoke.test", 'max_concurrent_chats' => 5]);
$widget = Widget::factory()->enabled()->withDomains(['smoke.test'])->create(['name' => "CutOff $run", 'offline_mode' => 'always_online']);
$category = Category::factory()->create(['slug' => "co-$run", 'name' => 'CutOff']);
$widget->categories()->attach($category->id, ['sort_order' => 0]);
foreach ([$agent, $colleague] as $user) {
    $category->users()->attach($user->id);
    AgentPresence::query()->updateOrCreate(['user_id' => $user->id], ['status' => 'online', 'last_seen_at' => now(), 'last_heartbeat_at' => now()]);
}
$tokens = app(VisitorTokenService::class);
$chat = function (string $label, ?User $assigned) use ($widget, $category, $tokens, $run) {
    $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => "Visitor $label", 'email' => "visitor-$label-$run@customer.test"]);
    $issued = $tokens->issue($visitor);
    $factory = Conversation::factory()->forCategory($category);
    $conversation = ($assigned ? $factory->active($assigned) : $factory)->create(['visitor_id' => $visitor->id, 'widget_id' => $widget->id, 'visitor_session_id' => $issued->session->id]);
    return [$issued, $conversation];
};
[$v1, $c1] = $chat('one', $agent);
[$v2, $c2] = $chat('two', $agent);
[$v3, $c3] = $chat('three', $agent);
echo 'JSON:'.json_encode([
    'adminId' => $adminAgent->id, 'agentId' => $agent->id, 'colleagueId' => $colleague->id,
    'adminToken' => $adminAgent->createToken('smoke', ['staff'])->plainTextToken,
    'agentToken' => $agent->createToken('smoke', ['staff'])->plainTextToken,
    'colleagueToken' => $colleague->createToken('smoke', ['staff'])->plainTextToken,
    'v1' => $v1->plaintext, 'c1' => $c1->ulid, 's1' => $v1->session->id,
    'v2' => $v2->plaintext, 'c2' => $c2->ulid, 's2' => $v2->session->id,
    'v3' => $v3->plaintext, 'c3' => $c3->ulid, 's3' => $v3->session->id,
    'widget' => $widget->id, 'widgetKey' => $widget->public_key, 'category' => $category->id,
]);
`;

const CLEANUP = String.raw`
use App\Models\{User, Widget, Category, Conversation};
$d = json_decode(getenv('SMOKE'), true);
Conversation::query()->whereIn('ulid', [$d['c1'], $d['c2'], $d['c3']])->get()->each(fn ($c) => $c->delete());
Widget::query()->whereKey($d['widget'])->get()->each(fn ($w) => $w->forceDelete());
Category::withTrashed()->whereKey($d['category'])->get()->each(fn ($c) => $c->forceDelete());
User::query()->whereIn('id', [$d['adminId'], $d['agentId'], $d['colleagueId']])->get()->each(function ($u) { $u->tokens()->delete(); $u->delete(); });
\Illuminate\Support\Facades\DB::table('socket_cutoffs')->delete();
echo 'JSON:{}';
`;

const WITH = (body) => String.raw`
use App\Domain\Chat\Enums\{SessionRevokeReason, SenderType};
use App\Domain\Chat\Events\{StaffSessionRevoked, MessageCreated, QueueChanged};
use App\Domain\Chat\Actions\TransferConversation;
use App\Models\{Conversation, Message, User, VisitorSession};
$d = json_decode(getenv('SMOKE'), true);
$t0 = microtime(true) * 1000;
$c1 = Conversation::query()->where('ulid', $d['c1'])->firstOrFail();
$agent = User::query()->findOrFail($d['agentId']);
$colleague = User::query()->findOrFail($d['colleagueId']);
$adminAgent = User::query()->findOrFail($d['adminId']);
${body}
echo 'JSON:'.json_encode(['t0' => $t0, 'done' => microtime(true) * 1000]);
`;

// ---- the run -------------------------------------------------------------------------------

async function run() {
    console.log(`database ${assertSafeDatabase()}, run ${RUN}`);

    start('reverb', 'php', ['artisan', 'reverb:start', '--host=127.0.0.1', `--port=${REVERB_PORT}`]);
    start(
        'web',
        'php',
        ['-S', `127.0.0.1:${WEB_PORT}`, join(ROOT, 'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php')],
        { cwd: join(ROOT, 'public') },
    );
    await Promise.all([waitForPort(REVERB_PORT), waitForPort(WEB_PORT)]);

    const fx = await php(SEED, { run: RUN });
    const data = { ...fx, run: RUN };

    try {
        await scenarios(fx, data);
    } finally {
        await php(CLEANUP, data).catch((error) =>
            console.log(`cleanup failed: ${error.message}`),
        );
    }
}

async function scenarios(fx, data) {
    const tokens = { v1: fx.v1, v2: fx.v2, v3: fx.v3 };

    const visitor1 = await connect(visitorAuth(() => tokens.v1), 'visitor 1');
    const visitor2 = await connect(visitorAuth(() => tokens.v2), 'visitor 2');
    const visitor3 = await connect(visitorAuth(() => tokens.v3), 'visitor 3');
    const agent = await connect(staffAuth(fx.agentToken), 'agent A');
    const colleague = await connect(staffAuth(fx.colleagueToken), 'agent B');
    const admin = await connect(staffAuth(fx.adminToken), 'admin+agent');
    const ch = {};

    await check('everybody subscribes the channels they may have', async () => {
        ch.v1 = await subscribe(visitor1, `private-conversation.${fx.c1}`);
        ch.v2 = await subscribe(visitor2, `private-conversation.${fx.c2}`);
        ch.v3 = await subscribe(visitor3, `private-conversation.${fx.c3}`);
        ch.agentStaff = await subscribe(agent, `private-staff.${fx.agentId}`);
        ch.agentRoster = await subscribe(agent, 'presence-staff');
        ch.agentC1 = await subscribe(agent, `private-conversation.${fx.c1}`);
        ch.agentC2 = await subscribe(agent, `private-conversation.${fx.c2}`);
        ch.colleagueStaff = await subscribe(colleague, `private-staff.${fx.colleagueId}`);
        ch.adminStaff = await subscribe(admin, `private-staff.${fx.adminId}`);
        ch.adminChannel = await subscribe(admin, 'private-admin');
        ch.adminWhatsApp = await subscribe(admin, 'private-whatsapp-admin');
        ch.adminRoster = await subscribe(admin, 'presence-staff');
    });

    const visitor1Inbox = inbox(ch.v1);
    const agentC1Inbox = inbox(ch.agentC1);
    const adminInbox = inbox(ch.adminChannel);
    const colleagueInbox = inbox(ch.colleagueStaff);
    const agentStaffInbox = inbox(ch.agentStaff);

    await check('whispers carry an opaque tag, never an integer id', async () => {
        // The raw frame carries the `user_id` Reverb adds to a whisper (the one signed into the sender's subscription); pusher-js only
        // surfaces it for presence channels, so read it where every client's devtools can: the connection's message stream.
        const whisperTo = (client, channelName) =>
            new Promise((done, fail) => {
                const timer = setTimeout(() => fail(new Error('no whisper')), 6000);
                const onMessage = (frame) => {
                    if (frame.event === 'client-typing' && frame.channel === channelName) {
                        clearTimeout(timer);
                        client.connection.unbind('message', onMessage);
                        done({ payload: frame.data, userId: frame.user_id });
                    }
                };

                client.connection.bind('message', onMessage);
            });
        const atVisitor = whisperTo(visitor1, `private-conversation.${fx.c1}`);
        const atAgent = whisperTo(agent, `private-conversation.${fx.c1}`);

        ch.agentC1.trigger('client-typing', { actor: 'agent', typing: true });
        ch.v1.trigger('client-typing', { actor: 'visitor', typing: true });
        const toVisitor = await atVisitor;
        const toAgent = await atAgent;

        expect(toVisitor.payload.actor === 'agent', 'payload');
        expect(/^s_[0-9a-f]{24}$/.test(String(toVisitor.userId)), `the visitor saw user_id=${toVisitor.userId}`);
        expect(toVisitor.userId !== String(fx.agentId), 'agent id leaked to the visitor');
        expect(/^v_[0-9a-f]{24}$/.test(String(toAgent.userId)), `the agent saw user_id=${toAgent.userId}`);

        return `${toVisitor.userId} / ${toAgent.userId}`;
    });

    await check('baseline: the administrator hears the admin channel', async () => {
        await php(WITH('QueueChanged::dispatch();'), data);
        const payload = await adminInbox.next('queue.updated');

        expect(typeof payload.queued === 'number', 'payload');
    });

    // ---- 1. an administrator who is demoted --------------------------------------------------
    await check('a demoted administrator: socket closed, reconnects, admin channels refused, own channels kept', async () => {
        const before = admin.connection.socket_id;
        const closed = closedAt(admin);

        const ran = await php(WITH('$adminAgent->forceFill(["is_admin" => false])->save();'), data);
        const ms = Math.round((await closed) - ran.t0);
        timings.push(['demoted administrator: socket closed after the change started', ms]);
        await connectedAgain(admin);
        expect(admin.connection.socket_id !== before, 'same socket id: it was not reconnected');
        await sleep(2500);

        expect(!ch.adminChannel.subscribed, 'private-admin is still subscribed after the demotion');
        expect(!ch.adminWhatsApp.subscribed, 'private-whatsapp-admin is still subscribed after the demotion');
        expect(ch.adminStaff.subscribed, 'the member lost private-staff.{id}, which they still may have');
        expect(ch.adminRoster.subscribed, 'the member lost presence-staff, which they still may have');

        adminInbox.received.length = 0;
        await php(WITH('QueueChanged::dispatch();'), data);
        await sleep(800);
        expect(!adminInbox.has('queue.updated'), 'the demoted member still receives admin events');

        return `closed after ${ms} ms`;
    });

    // ---- 2. an agent a chat is transferred away from -----------------------------------------
    await check('a transfer closes the previous agent socket only; the visitor and the colleague are not disturbed', async () => {
        const visitorSocket = visitor1.connection.socket_id;
        const colleagueSocket = colleague.connection.socket_id;
        const closed = closedAt(agent);

        const ran = await php(WITH('app(TransferConversation::class)->handle($c1, $agent, $colleague, null);'), data);
        const ms = Math.round((await closed) - ran.t0);
        timings.push(['transferred-away agent: socket closed after', ms]);
        await connectedAgain(agent);
        await sleep(2500);

        expect(!ch.agentC1.subscribed, 'the agent is still subscribed to the conversation they lost');
        expect(ch.agentStaff.subscribed && ch.agentRoster.subscribed, 'the agent lost their own channels');
        expect(ch.agentC2.subscribed, 'the agent lost another conversation they still hold');
        expect(visitor1.connection.socket_id === visitorSocket && visitor1.connection.state === 'connected', 'the visitor socket was disturbed');
        expect(colleague.connection.socket_id === colleagueSocket && colleague.connection.state === 'connected', 'the colleague socket was disturbed');

        // what the old agent can no longer hear
        agentC1Inbox.received.length = 0;
        await php(WITH('$m = Message::factory()->for($c1)->create(["body" => "after the transfer"]); MessageCreated::dispatch($m);'), data);
        await visitor1Inbox.next('message.created');
        await sleep(600);
        expect(!agentC1Inbox.has('message.created'), 'the previous agent still receives the conversation');

        return `closed after ${ms} ms`;
    });

    // ---- 3. session.revoked, then the socket closes -------------------------------------------
    await check('a revoked staff session hears session.revoked and then loses the socket', async () => {
        const closed = closedAt(colleague);

        const ran = await php(WITH('StaffSessionRevoked::dispatch($colleague->id, SessionRevokeReason::AuthRevoked);'), data);
        const revoked = await colleagueInbox.next('session.revoked').catch(() => null);
        const ms = Math.round((await closed) - ran.t0);
        timings.push(['revoked staff session: socket closed after', ms]);

        expect(revoked !== null && revoked.reason === 'auth_revoked', 'the session.revoked frame did not arrive before the close');

        return `frame delivered, closed after ${ms} ms`;
    });

    // ---- 4. deactivation ----------------------------------------------------------------------
    await check('a deactivated agent is closed and cannot authorise again', async () => {
        const closed = closedAt(agent);

        const ran = await php(WITH('$agent->forceFill(["is_active" => false])->save();'), data);
        const ms = Math.round((await closed) - ran.t0);
        timings.push(['deactivated agent: socket closed after', ms]);
        await connectedAgain(agent).catch(() => null);
        await sleep(2500);

        expect(!ch.agentStaff.subscribed && !ch.agentRoster.subscribed && !ch.agentC2.subscribed, 'a deactivated agent is still subscribed');

        return `closed after ${ms} ms`;
    });

    // ---- 5. visitor tokens --------------------------------------------------------------------
    await check('a revoked visitor token: socket closed, reconnect refused (401), the other visitors untouched', async () => {
        const others = [visitor2.connection.socket_id, visitor3.connection.socket_id];
        const closed = closedAt(visitor1);

        const t0 = Date.now();
        const response = await fetch(`${WEB}/api/v1/public/sessions`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${tokens.v1}`, Accept: 'application/json' },
        });

        expect(response.status === 204, `DELETE /public/sessions answered ${response.status}`);
        const ms = Math.round((await closed) - t0);
        timings.push(['revoked visitor token: socket closed after', ms]);
        await connectedAgain(visitor1);
        await sleep(1500);

        expect(!ch.v1.subscribed, 'the revoked token is subscribed again');
        expect([visitor2.connection.socket_id, visitor3.connection.socket_id].join() === others.join(), 'another visitor was disturbed');

        return `closed after ${ms} ms`;
    });

    await check('a rotated token: the previous token loses its socket, the new token subscribes seamlessly', async () => {
        const closed = closedAt(visitor2);

        const t0 = Date.now();
        const response = await fetch(`${WEB}/api/v1/public/widgets/${fx.widgetKey}/sessions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${tokens.v2}`,
                Origin: 'https://smoke.test',
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        const body = await response.json();

        expect(response.status === 201, `sessions answered ${response.status}`);
        tokens.v2 = body.data.visitorToken; // the panel adopts the new token; its reconnect authorises with it
        const ms = Math.round((await closed) - t0);
        timings.push(['rotated visitor token: previous socket closed after', ms]);
        await connectedAgain(visitor2);
        await sleep(2000);

        expect(ch.v2.subscribed, 'the panel did not get its conversation back with the new token');

        return `closed after ${ms} ms, resubscribed with the new token`;
    });

    await check('an expired visitor token is closed by the sweep', async () => {
        const closed = closedAt(visitor3);

        await php(WITH('VisitorSession::query()->whereKey($d["s3"])->update(["expires_at" => now()->subMinute()]);'), data);
        const t0 = Date.now();
        const summary = await artisan('chat:realtime-sweep');
        const ms = Math.round((await closed) - t0);
        timings.push(['expired visitor token: socket closed by the sweep after', ms]);

        return `${summary.split('\n').pop()} (closed after ${ms} ms)`;
    });

    // ---- 6. Reverb unreachable --------------------------------------------------------------
    await check('a cut that cannot reach Reverb is parked, never fails, and is worked off later', async () => {
        process.kill(-children[0].pid, 'SIGTERM');
        await sleep(1200);

        const started = Date.now();
        await php(WITH('$colleague->forceFill(["is_active" => false])->save();'), data);
        const took = Date.now() - started;
        const parked = await php(
            'echo "JSON:".\\App\\Models\\PendingSocketCut::query()->where("attempts", ">", 0)->count();',
        );

        expect(parked >= 1, `nothing was parked (${parked})`);

        start('reverb', 'php', ['artisan', 'reverb:start', '--host=127.0.0.1', `--port=${REVERB_PORT}`]);
        await waitForPort(REVERB_PORT);
        await sleep(6500);
        const summary = await artisan('chat:realtime-sweep');
        const left = await php(
            'echo "JSON:".\\App\\Models\\PendingSocketCut::query()->where("attempts", ">", 0)->count();',
        );

        expect(left === 0, `${left} retries are still parked: ${summary}`);

        return `${parked} parked while Reverb was down (the change itself took ${took} ms), then worked off`;
    });

    for (const client of [visitor1, visitor2, visitor3, agent, colleague, admin]) {
        client.disconnect();
    }
}

try {
    await run();
} catch (error) {
    record('run', false, error instanceof Error ? error.message : String(error));
} finally {
    stopAll();
}

const failed = results.filter((entry) => !entry.ok);

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

for (const [what, ms] of timings) {
    console.log(`  ${what} ${ms} ms`);
}

if (failed.length > 0) {
    console.log('\nlast server output:\n' + logs.slice(-40).join('\n'));
}

process.exit(failed.length === 0 ? 0 : 1);
