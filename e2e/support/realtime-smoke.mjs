#!/usr/bin/env node
/**
 * Real-socket smoke test of the chat realtime layer (P4, track 4B). NOT part of
 * `composer test`, `npm test` or Playwright: run it by hand,
 *
 *     node e2e/support/realtime-smoke.mjs
 *
 * It starts `php artisan reverb:start` and a PHP web server on the ports below,
 * seeds a few rows into the database of this checkout (and removes them again),
 * connects a visitor and two staff clients with `pusher-js` (the library the
 * browser clients use), triggers the domain events of the Chat context from a
 * second PHP process and checks what arrives over the wire: channel
 * authorisation (visitor bearer endpoint and the staff endpoint), the origin
 * check, every server event, whispers, and that a dead Reverb does not break a
 * PHP process that dispatches events.
 *
 * Needs: the `RealtimeServiceProvider` registered in bootstrap/providers.php
 * and a migrated MySQL database whose name starts with `chatfeature_p4_`,
 * `chatfeature_rt` or `chatfeature_e2e` (never the shared dev database).
 * Redis is not needed: the queue is `sync`, cache and sessions use files.
 * Ports (override with REALTIME_SMOKE_WEB_PORT / REALTIME_SMOKE_REVERB_PORT):
 * web 8302, Reverb 8312.
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
const WEB_PORT = Number(process.env.REALTIME_SMOKE_WEB_PORT ?? 8302);
const REVERB_PORT = Number(process.env.REALTIME_SMOKE_REVERB_PORT ?? 8312);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const KEY = 'smoke-key';
const RUN = Math.random().toString(36).slice(2, 8);

/** Environment for every PHP process: the real broadcaster, no Redis. */
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
    REVERB_APP_ID: '1001',
    REVERB_APP_KEY: KEY,
    REVERB_APP_SECRET: 'smoke-secret',
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

// ---- safety --------------------------------------------------------------------------------

function databaseName() {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const match = /^DB_DATABASE=(.*)$/m.exec(env);

    return (process.env.DB_DATABASE ?? match?.[1] ?? '').replaceAll('"', '');
}

function assertSafeDatabase() {
    const name = databaseName();

    if (!/^chatfeature_(p4_|rt|e2e)/.test(name)) {
        throw new Error(
            `Refusing to seed into database "${name}": use a dedicated chatfeature_p4_* / chatfeature_rt* / chatfeature_e2e* database.`,
        );
    }

    return name;
}

// ---- processes -----------------------------------------------------------------------------

/** Runs PHP inside the application and returns the JSON the snippet printed after `JSON:`. */
async function tinker(code, data = {}) {
    const env = { ...PHP_ENV, SMOKE: JSON.stringify(data) };
    const { stdout } = await execFileAsync(
        'php',
        ['artisan', 'tinker', '--execute', code, '--no-interaction'],
        { cwd: ROOT, env, timeout: 120_000, maxBuffer: 8_000_000 },
    );
    const line = stdout.split('\n').find((row) => row.startsWith('JSON:'));

    return line === undefined ? null : JSON.parse(line.slice(5));
}

function start(name, command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd ?? ROOT,
        env: PHP_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group: the PHP web server forks workers that outlive a plain kill.
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

/**
 * pusher-js in Node opens its websocket without an Origin header, which Reverb
 * (rightly) refuses once `allowed_origins` is not `*`: a browser always sends
 * one, so the smoke test does too.
 */
let nextOrigin = WEB;
const WebSocketClient = Pusher.Runtime.getWebSocketAPI();
Pusher.Runtime.createWebSocket = (url) =>
    new WebSocketClient(url, [], { headers: { Origin: nextOrigin } });

function staffAuth(token) {
    return {
        endpoint: `${WEB}/broadcasting/auth`,
        headers: { Authorization: `Bearer ${token}` },
    };
}

function visitorAuth(token) {
    return {
        endpoint: `${WEB}/api/v1/public/broadcasting/auth`,
        headers: { Authorization: `Bearer ${token}` },
    };
}

async function connect(auth) {
    nextOrigin = WEB;
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
                fetch(auth.endpoint, {
                    method: 'POST',
                    headers: {
                        ...auth.headers,
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
                            callback(
                                new Error(`auth ${response.status}`),
                                null,
                            );

                            return;
                        }

                        callback(null, await response.json());
                    })
                    .catch((error) => callback(error, null));
            },
        },
    });

    await new Promise((done, fail) => {
        const timer = setTimeout(
            () => fail(new Error('connect timeout')),
            8000,
        );

        pusher.connection.bind('connected', () => {
            clearTimeout(timer);
            done();
        });
        pusher.connection.bind('error', (error) => {
            clearTimeout(timer);
            fail(new Error(`connection error ${JSON.stringify(error)}`));
        });
    });

    return pusher;
}

/** Resolves when the channel is subscribed, rejects when the authorisation was refused. */
function subscribe(pusher, name) {
    return new Promise((done, fail) => {
        const channel = pusher.subscribe(name);
        const timer = setTimeout(
            () => fail(new Error(`subscribe ${name}: timeout`)),
            6000,
        );

        channel.bind('pusher:subscription_succeeded', () => {
            clearTimeout(timer);
            done(channel);
        });
        channel.bind('pusher:subscription_error', (error) => {
            clearTimeout(timer);
            fail(
                new Error(
                    `subscribe ${name}: refused (${error?.status ?? JSON.stringify(error)})`,
                ),
            );
        });
    });
}

async function refused(pusher, name) {
    try {
        await subscribe(pusher, name);
    } catch (error) {
        return String(error.message);
    }

    throw new Error(`${name} was NOT refused`);
}

/** Collects events of a channel so they can be awaited after they were sent. */
function inbox(channel) {
    const received = [];
    const waiters = [];

    channel.bind_global((event, data) => {
        if (event.startsWith('pusher')) {
            return;
        }

        received.push({ event, data });

        const ready = waiters.filter((waiter) => waiter.event === event);

        for (const waiter of ready) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.done(data);
        }
    });

    return {
        received,
        next(event, timeoutMs = 6000) {
            const earlier = received.find((entry) => entry.event === event);

            if (earlier !== undefined) {
                received.splice(received.indexOf(earlier), 1);

                return Promise.resolve(earlier.data);
            }

            return new Promise((done, fail) => {
                const waiter = {
                    event,
                    done: (data) => {
                        const index = received.findIndex(
                            (entry) => entry.event === event,
                        );

                        if (index >= 0) {
                            received.splice(index, 1);
                        }

                        done(data);
                    },
                };
                waiters.push(waiter);
                setTimeout(() => {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    fail(new Error(`no "${event}" within ${timeoutMs} ms`));
                }, timeoutMs);
            });
        },
    };
}

// ---- fixtures ------------------------------------------------------------------------------

const SEED = String.raw`
use App\Models\{User, Widget, Visitor, Category, Conversation, ConversationOffer};
use App\Domain\Visitors\VisitorTokenService;
$run = json_decode(getenv('SMOKE'), true)['run'];
settings()->set('auth.mode', 'fortify');
$admin = User::factory()->admin()->create(['name' => 'Smoke Admin', 'email' => "rt-admin-$run@smoke.test"]);
$agent = User::factory()->agent()->create(['name' => 'Smoke Agent', 'display_name' => 'Sam', 'email' => "rt-agent-$run@smoke.test"]);
$other = User::factory()->agent()->create(['name' => 'Other Agent', 'email' => "rt-other-$run@smoke.test"]);
$widget = Widget::factory()->enabled()->withDomains(['smoke.test'])->create(['name' => "Smoke $run"]);
$category = Category::factory()->create(['slug' => "rt-$run", 'name' => 'Smoke']);
$widget->categories()->attach($category->id, ['sort_order' => 0]);
$tokens = app(VisitorTokenService::class);
$make = function (string $label) use ($widget, $category, $tokens, $run) {
    $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => "Visitor $label", 'email' => "visitor-$label-$run@customer.test", 'phone' => '+49 30 555 0101']);
    $issued = $tokens->issue($visitor);
    $conversation = Conversation::factory()->forCategory($category)->create(['visitor_id' => $visitor->id, 'widget_id' => $widget->id, 'visitor_session_id' => $issued->session->id, 'last_message_preview' => 'Hello from the smoke test']);
    return [$issued->plaintext, $conversation];
};
[$tokenA, $conversationA] = $make('a');
[$tokenB, $conversationB] = $make('b');
ConversationOffer::factory()->create(['conversation_id' => $conversationA->id, 'user_id' => $agent->id]);
echo 'JSON:'.json_encode([
    'adminId' => $admin->id, 'agentId' => $agent->id, 'otherId' => $other->id,
    'adminToken' => $admin->createToken('smoke', ['staff'])->plainTextToken,
    'agentToken' => $agent->createToken('smoke', ['staff'])->plainTextToken,
    'otherToken' => $other->createToken('smoke', ['staff'])->plainTextToken,
    'visitorAToken' => $tokenA, 'conversationA' => $conversationA->ulid,
    'visitorBToken' => $tokenB, 'conversationB' => $conversationB->ulid,
    'widget' => $widget->id, 'category' => $category->id,
]);
`;

const CLEANUP = String.raw`
use App\Models\{User, Widget, Category, Conversation};
$d = json_decode(getenv('SMOKE'), true);
Conversation::query()->whereIn('ulid', [$d['conversationA'], $d['conversationB']])->get()->each(fn ($c) => $c->delete());
Widget::query()->whereKey($d['widget'])->get()->each(fn ($w) => $w->forceDelete());
Category::withTrashed()->whereKey($d['category'])->get()->each(fn ($c) => $c->forceDelete());
User::query()->whereIn('id', [$d['adminId'], $d['agentId'], $d['otherId']])->get()->each(function ($u) { $u->tokens()->delete(); $u->delete(); });
echo 'JSON:{}';
`;

/** One PHP process that dispatches the given domain events (after the preamble). */
function events(body) {
    return String.raw`
use App\Domain\Chat\Enums\{ConversationEndedBy, PresenceStatus, SenderType, SessionRevokeReason};
use App\Domain\Chat\Events\{ChatOffered, ConversationClaimed, ConversationEnded, MessageCreated, MessagesSeen, PresenceChanged, QueueChanged, StaffSessionRevoked};
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Models\{Conversation, Message, User};
$d = json_decode(getenv('SMOKE'), true);
$conversation = Conversation::query()->where('ulid', $d['conversationA'])->firstOrFail();
$agent = User::query()->findOrFail($d['agentId']);
${body}
echo 'JSON:{}';
`;
}

// ---- the run -------------------------------------------------------------------------------

async function run() {
    console.log(`database ${assertSafeDatabase()}, run ${RUN}`);

    const registered = await tinker(
        String.raw`echo 'JSON:'.json_encode(app()->getProvider(\App\Providers\RealtimeServiceProvider::class) !== null);`,
    );

    if (registered !== true) {
        throw new Error(
            'App\\Providers\\RealtimeServiceProvider is not registered in bootstrap/providers.php.',
        );
    }

    start('reverb', 'php', [
        'artisan',
        'reverb:start',
        '--host=127.0.0.1',
        `--port=${REVERB_PORT}`,
    ]);
    start(
        'web',
        'php',
        [
            '-S',
            `127.0.0.1:${WEB_PORT}`,
            join(
                ROOT,
                'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php',
            ),
        ],
        { cwd: join(ROOT, 'public') },
    );
    await Promise.all([waitForPort(REVERB_PORT), waitForPort(WEB_PORT)]);

    const fx = await tinker(SEED, { run: RUN });
    const data = { ...fx, run: RUN };

    try {
        await scenarios(fx, data);
    } finally {
        await tinker(CLEANUP, data).catch((error) =>
            console.log(`cleanup failed: ${error.message}`),
        );
    }
}

async function scenarios(fx, data) {
    await check('web server and visitor endpoint are up', async () => {
        const response = await fetch(`${WEB}/api/v1/public/broadcasting/auth`, {
            method: 'POST',
        });

        expect(response.status === 401, `expected 401, got ${response.status}`);
    });

    await check('origin check: a foreign Origin is refused', async () => {
        const WebSocket = require('ws');
        const url = `ws://127.0.0.1:${REVERB_PORT}/app/${KEY}?protocol=7`;
        const outcome = await new Promise((done) => {
            const socket = new WebSocket(url, {
                headers: { Origin: 'https://evil.example' },
            });
            const timer = setTimeout(() => done('timeout'), 4000);

            socket.on('message', (message) => {
                clearTimeout(timer);
                done(String(message));
                socket.close();
            });
            socket.on('close', () => {
                clearTimeout(timer);
                done('closed');
            });
            socket.on('error', () => {
                clearTimeout(timer);
                done('error');
            });
        });

        expect(
            !outcome.includes('connection_established'),
            `foreign origin was accepted: ${outcome}`,
        );

        return outcome.slice(0, 80);
    });

    const visitor = await connect(visitorAuth(fx.visitorAToken));
    const agent = await connect(staffAuth(fx.agentToken));
    const admin = await connect(staffAuth(fx.adminToken));
    const other = await connect(staffAuth(fx.otherToken));
    const channels = {};

    await check('visitor joins the conversation of its session', async () => {
        channels.visitor = await subscribe(
            visitor,
            `private-conversation.${fx.conversationA}`,
        );
    });

    await check('visitor cannot join other channels', async () => {
        const other = [
            `private-conversation.${fx.conversationB}`,
            `private-staff.${fx.agentId}`,
            'private-admin',
            'presence-staff',
            'private-whatsapp-admin',
        ];

        for (const name of other) {
            await refused(visitor, name);
        }

        return `${other.length} channels refused`;
    });

    await check('staff join their channels', async () => {
        channels.agentStaff = await subscribe(
            agent,
            `private-staff.${fx.agentId}`,
        );
        channels.agentRoster = await subscribe(agent, 'presence-staff');
        channels.agentConversation = await subscribe(
            agent,
            `private-conversation.${fx.conversationA}`,
        );
        channels.adminStaff = await subscribe(
            admin,
            `private-staff.${fx.adminId}`,
        );
        channels.admin = await subscribe(admin, 'private-admin');
        channels.adminConversation = await subscribe(
            admin,
            `private-conversation.${fx.conversationB}`,
        );
    });

    await check('staff cannot join what is not theirs', async () => {
        await refused(agent, `private-staff.${fx.otherId}`);
        await refused(agent, 'private-admin');
        await refused(other, `private-conversation.${fx.conversationA}`);
        await refused(agent, 'private-whatsapp-admin');
        await refused(admin, 'private-whatsapp-admin');
    });

    const visitorInbox = inbox(channels.visitor);
    const agentInbox = inbox(channels.agentStaff);
    const conversationInbox = inbox(channels.agentConversation);
    const adminInbox = inbox(channels.admin);
    const rosterInbox = inbox(channels.agentRoster);

    await check('chat.offered reaches the offered agent', async () => {
        await tinker(
            events(
                '$offers = $conversation->offers()->get(); ChatOffered::dispatch($conversation, $offers, 1, now()->addSeconds(90));',
            ),
            data,
        );
        const payload = await agentInbox.next('chat.offered');

        expect(payload.v === 1, 'v');
        expect(payload.conversation === fx.conversationA, 'conversation');
        expect(payload.visitor.name === 'Visitor a', 'visitor name');
        expect(!JSON.stringify(payload).includes('@customer.test'), 'email');
    });

    await check('queue.updated reaches staff and admins', async () => {
        await tinker(events('QueueChanged::dispatch();'), data);
        const forAgent = await agentInbox.next('queue.updated');
        const forAdmin = await adminInbox.next('queue.updated');

        expect(forAgent.queued === 1, `agent sees ${forAgent.queued}`);
        expect(forAdmin.queued === 2, `admin sees ${forAdmin.queued}`);
    });

    await check(
        'claiming reaches the visitor, the agent and the admins',
        async () => {
            await tinker(
                events(
                    '$conversation->forceFill(["status" => "active", "assigned_agent_id" => $agent->id, "claimed_at" => now()])->save(); ConversationClaimed::dispatch($conversation, $agent);',
                ),
                data,
            );
            const claimed = await visitorInbox.next('chat.claimed');
            const updated = await adminInbox.next('conversation.updated');

            expect(claimed.agent.name === 'Sam', 'agent name');
            expect(!('id' in claimed.agent), 'agent id leaked to the visitor');
            expect(
                updated.conversation.assignedAgent.id === fx.agentId,
                'assignee',
            );
            await agentInbox.next('conversation.updated');
        },
    );

    await check(
        'message.created is visitor safe on the shared channel',
        async () => {
            await tinker(
                events(
                    '$m = Message::factory()->for($conversation)->fromAgent($agent)->create(["body" => "Hi Visitor a"]); MessageCreated::dispatch($m);',
                ),
                data,
            );
            const toVisitor = await visitorInbox.next('message.created');
            const toAgent = await conversationInbox.next('message.created');
            const json = JSON.stringify(toVisitor);

            expect(toVisitor.message.body === 'Hi Visitor a', 'body');
            expect(toVisitor.message.sender.type === 'agent', 'sender type');
            expect(!('id' in toVisitor.message.sender), 'sender id');
            expect(!json.includes('rt-agent-'), 'agent email');
            expect(
                toAgent.message.ulid === toVisitor.message.ulid,
                'same message',
            );
        },
    );

    await check('receipts, ending and the typing fallback', async () => {
        await tinker(
            events(
                'MessagesSeen::dispatch($conversation, 1, SenderType::Agent); ConversationEnded::dispatch($conversation, ConversationEndedBy::Agent); TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, true);',
            ),
            data,
        );
        const seen = await visitorInbox.next('message.seen');
        const ended = await visitorInbox.next('conversation.ended');
        const typing = await visitorInbox.next('typing');

        expect(seen.upToSeq === 1 && seen.by === 'agent', 'seen');
        expect(ended.endedBy === 'agent', 'ended by');
        expect(typing.actor === 'agent' && typing.typing === true, 'typing');
    });

    await check('presence.changed reaches the staff roster', async () => {
        await tinker(
            events(
                'PresenceChanged::dispatch($agent->id, PresenceStatus::Away);',
            ),
            data,
        );
        const payload = await rosterInbox.next('presence.changed');

        expect(
            payload.userId === fx.agentId && payload.status === 'away',
            'payload',
        );
    });

    await check('client whispers are relayed between members', async () => {
        channels.visitor.trigger('client-typing', {
            actor: 'visitor',
            typing: true,
        });
        const whisper = await conversationInbox.next('client-typing');

        expect(
            whisper.actor === 'visitor' && whisper.typing === true,
            'whisper',
        );
    });

    await check('session.revoked reaches that staff channel only', async () => {
        await tinker(
            events(
                'StaffSessionRevoked::dispatch($agent->id, SessionRevokeReason::Deactivated);',
            ),
            data,
        );
        const payload = await agentInbox.next('session.revoked');

        expect(payload.reason === 'deactivated', 'reason');
        await sleep(300);
        expect(
            adminInbox.received.every(
                (entry) => entry.event !== 'session.revoked',
            ),
            'another staff member heard it',
        );
    });

    for (const client of [visitor, agent, admin, other]) {
        client.disconnect();
    }

    await check(
        'a dead Reverb does not break the process that dispatches events',
        async () => {
            process.kill(-children[0].pid, 'SIGTERM');
            await sleep(800);
            const started = Date.now();

            await tinker(
                events(
                    '$m = Message::factory()->for($conversation)->create(["body" => "while Reverb is down"]); MessageCreated::dispatch($m); QueueChanged::dispatch();',
                ),
                data,
            );

            return `${Date.now() - started} ms`;
        },
    );
}

try {
    await run();
} catch (error) {
    record(
        'run',
        false,
        error instanceof Error ? error.message : String(error),
    );
} finally {
    stopAll();
}

const failed = results.filter((entry) => !entry.ok);

console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
);

if (failed.length > 0) {
    console.log('\nlast server output:\n' + logs.slice(-40).join('\n'));
}

process.exit(failed.length === 0 ? 0 : 1);
