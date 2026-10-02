#!/usr/bin/env node
/**
 * Load test of the chat's realtime path (P7, docs/runbook.md "Load test results"): about 1 000 visitor websockets plus a team of agents, against
 * a real Reverb and the real HTTP API.
 *
 *     node scripts/loadtest-realtime.mjs --visitors=1000 --agents=20 --duration=60 \
 *         --web=http://127.0.0.1:8312 --reverb-port=8316 --spawn
 *
 * What it does (every step through the public / management API, nothing is written into the database behind the application's back
 * except the provisioning of the throwaway widgets, agents and tokens at the start, removed at the end):
 *  1. provisions widgets (visitors are spread over them: the start-a-chat budget is per widget), a category, online agents with Sanctum tokens;
 *  2. connects the agents (pusher-js, bearer auth: `private-staff.{id}`, `presence-staff`) and keeps them online (heartbeat);
 *  3. ramps the visitors up: `POST /public/widgets/{key}/sessions` (a visitor token), `POST /public/conversations` (the chat is offered to every
 *     online agent, ONE agent accepts it through the API), then a websocket authorised by `POST /public/broadcasting/auth` and subscribed to
 *     `private-conversation.{ulid}`: the connect and subscribe times are recorded;
 *  4. the message storm: every visitor sends a message every `--interval` seconds (jittered) and an agent answers a share of them; the latency of
 *     a message is the time from the moment its POST was sent to the moment `message.created` arrived on the visitor's own socket;
 *  5. samples the CPU, resident memory and open file descriptors of the Reverb process (and the CPU of the PHP workers and MySQL), counts
 *     disconnects, errors and lost events, prints a summary and writes JSON (`--out`).
 *
 * `--spawn-web` starts only the web server (Reverb runs elsewhere, for example in a container with `ext-uv`, see docs/runbook.md); `--spawn` starts `php artisan reverb:start` and a PHP web server on the ports given (a fresh database named chatfeature_p7_* / chatfeature_perf*
 * only, QUEUE_CONNECTION=sync, TRUSTED_PROXIES=* so each simulated visitor has its own network address for the rate limiters). Without it point
 * the script at servers you started (`--reverb-host`, `--reverb-port`, `--reverb-pid` or `--reverb-container`).
 * The macOS default of 256 open files is far too low: run it from a shell with `ulimit -n 65536`.
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Pusher = require('pusher-js');
const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- options ---------------------------------------------------------------------------------------------------------------------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');

        return [key, value ?? 'true'];
    }),
);
const opt = (name, fallback) =>
    args[name] === undefined
        ? fallback
        : Number.isNaN(Number(args[name]))
          ? args[name]
          : Number(args[name]);

const VISITORS = opt('visitors', 1000);
const AGENTS = opt('agents', 20);
const WIDGETS = Math.max(1, opt('widgets', Math.ceil(VISITORS / 100)));
const DURATION = opt('duration', 60);
const INTERVAL = opt('interval', 10);
const REPLY_SHARE = opt('reply-share', 0.5);
const RAMP = opt('ramp-per-second', 25);
const WEB_PORT = opt('web-port', 8312);
const REVERB_PORT = opt('reverb-port', 8316);
const WEB = String(opt('web', `http://127.0.0.1:${WEB_PORT}`));
const REVERB_HOST = String(opt('reverb-host', '127.0.0.1'));
const WEB_WORKERS = opt('web-workers', 24);
const KEY = 'loadtest-key';
const SECRET = 'loadtest-secret';
const OUT = args.out;
const RUN = Math.random().toString(36).slice(2, 8);
let reverbPid = opt('reverb-pid', null);
const reverbContainer = args['reverb-container'] ?? null;

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
    PRESENCE_STORE: 'database',
    TRUSTED_PROXIES: '*',
    LOG_LEVEL: 'error',
    REVERB_APP_ID: '1003',
    REVERB_APP_KEY: KEY,
    REVERB_APP_SECRET: SECRET,
    REVERB_HOST: REVERB_HOST,
    REVERB_PORT: String(REVERB_PORT),
    REVERB_SCHEME: 'http',
    REVERB_SERVER_HOST: '0.0.0.0',
    REVERB_SERVER_PORT: String(REVERB_PORT),
    REVERB_ALLOWED_ORIGINS: '127.0.0.1,localhost',
    PHP_CLI_SERVER_WORKERS: String(WEB_WORKERS),
};

const children = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const now = () => performance.now();

// ---- helpers ---------------------------------------------------------------------------------------------------------------------

function assertSafeDatabase() {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const name = (
        process.env.DB_DATABASE ??
        /^DB_DATABASE=(.*)$/m.exec(env)?.[1] ??
        ''
    ).replaceAll('"', '');

    if (!/^chatfeature_(p7_|perf|rt|e2e)/.test(name)) {
        throw new Error(
            `Refusing to provision into database "${name}": use a dedicated chatfeature_p7_* / perf* database.`,
        );
    }

    return name;
}

async function php(code, data = {}) {
    const { stdout } = await execFileAsync(
        'php',
        ['artisan', 'tinker', '--execute', code, '--no-interaction'],
        {
            cwd: ROOT,
            env: { ...PHP_ENV, LOADTEST: JSON.stringify(data) },
            timeout: 300_000,
            maxBuffer: 64_000_000,
        },
    );
    const line = stdout.split('\n').find((row) => row.startsWith('JSON:'));

    return line === undefined ? null : JSON.parse(line.slice(5));
}

function start(name, command, commandArgs, options = {}) {
    const child = spawn(command, commandArgs, {
        cwd: options.cwd ?? ROOT,
        env: PHP_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    const lines = [];

    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
            lines.push(chunk.toString().trimEnd());

            if (lines.length > 200) {
                lines.shift();
            }
        });
    }

    child.lines = lines;
    child.label = name;
    children.push(child);

    return child;
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((done, fail) => {
        const attempt = () => {
            const socket = net.connect(port, host);

            socket.once('connect', () => {
                socket.destroy();
                done();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    fail(new Error(`port ${port} did not open`));
                } else {
                    setTimeout(attempt, 250);
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

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return null;
    }

    return (
        Math.round(
            sorted[
                Math.min(
                    sorted.length - 1,
                    Math.ceil((p / 100) * sorted.length) - 1,
                )
            ] * 10,
        ) / 10
    );
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);

    return {
        n: sorted.length,
        min: sorted.length ? Math.round(sorted[0] * 10) / 10 : null,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.length
            ? Math.round(sorted[sorted.length - 1] * 10) / 10
            : null,
    };
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------------------

const httpStats = {
    requests: 0,
    byStatus: {},
    networkErrors: 0,
    byRoute: {},
    errorCodes: {},
};

async function call(
    route,
    method,
    path,
    { token, body, headers = {}, ip } = {},
) {
    const started = now();
    httpStats.requests++;

    try {
        const response = await fetch(`${WEB}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(ip ? { 'X-Forwarded-For': ip } : {}),
                ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        const ms = now() - started;
        const key = `${route} ${response.status}`;

        httpStats.byStatus[response.status] =
            (httpStats.byStatus[response.status] ?? 0) + 1;
        httpStats.byRoute[key] = (httpStats.byRoute[key] ?? 0) + 1;
        (call.durations[route] ??= []).push(ms);

        return {
            status: response.status,
            json: text ? safeJson(text) : null,
            ms,
        };
    } catch (error) {
        const code = String(error?.cause?.code ?? error?.message ?? error);

        httpStats.networkErrors++;
        httpStats.errorCodes[code] = (httpStats.errorCodes[code] ?? 0) + 1;
        httpStats.byRoute[`${route} network-error`] =
            (httpStats.byRoute[`${route} network-error`] ?? 0) + 1;

        return { status: 0, json: null, ms: now() - started, error: code };
    }
}
call.durations = {};

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const visitorIp = (n) =>
    `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255 || 1}`;

// ---- Pusher clients --------------------------------------------------------------------------------------------------------------

const WebSocketClient = Pusher.Runtime.getWebSocketAPI();
Pusher.Runtime.createWebSocket = (url) =>
    new WebSocketClient(url, [], { headers: { Origin: WEB } });

/** A Pusher client whose private-channel authorisation is one timed POST per subscription (the cost the dashboard's real clients pay). */
function authenticatingPusher(endpoint, bearer, ip, label) {
    const pusher = new Pusher(KEY, {
        cluster: 'mt1',
        wsHost: REVERB_HOST,
        wsPort: REVERB_PORT,
        forceTLS: false,
        enabledTransports: ['ws'],
        disableStats: true,
        channelAuthorization: {
            transport: 'ajax',
            endpoint,
            customHandler: ({ socketId, channelName }, callback) => {
                const started = now();

                fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${bearer}`,
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        ...(ip ? { 'X-Forwarded-For': ip } : {}),
                    },
                    body: new URLSearchParams({
                        socket_id: socketId,
                        channel_name: channelName,
                    }),
                })
                    .then(async (response) => {
                        httpStats.requests++;
                        httpStats.byStatus[response.status] =
                            (httpStats.byStatus[response.status] ?? 0) + 1;
                        (call.durations['broadcasting-auth'] ??= []).push(
                            now() - started,
                        );

                        if (!response.ok) {
                            httpStats.byRoute[
                                `broadcasting-auth ${response.status}`
                            ] =
                                (httpStats.byRoute[
                                    `broadcasting-auth ${response.status}`
                                ] ?? 0) + 1;
                            callback(
                                new Error(`auth ${response.status}`),
                                null,
                            );

                            return;
                        }

                        callback(null, await response.json());
                    })
                    .catch((error) => {
                        httpStats.networkErrors++;
                        callback(error, null);
                    });
            },
        },
    });

    pusher.label = label;

    return pusher;
}

function connected(pusher, timeoutMs = 30_000) {
    const started = now();

    return new Promise((done, fail) => {
        if (pusher.connection.state === 'connected') {
            done(0);

            return;
        }

        const timer = setTimeout(
            () =>
                fail(
                    new Error(
                        `${pusher.label}: connect timeout (${pusher.connection.state})`,
                    ),
                ),
            timeoutMs,
        );

        pusher.connection.bind('connected', () => {
            clearTimeout(timer);
            done(now() - started);
        });
        pusher.connection.bind('error', () => {});
    });
}

function subscribed(pusher, name, timeoutMs = 30_000) {
    const started = now();

    return new Promise((done, fail) => {
        const channel = pusher.subscribe(name);
        const timer = setTimeout(
            () => fail(new Error(`${pusher.label}: subscribe ${name} timeout`)),
            timeoutMs,
        );

        channel.bind('pusher:subscription_succeeded', () => {
            clearTimeout(timer);
            done({ channel, ms: now() - started });
        });
        channel.bind('pusher:subscription_error', (error) => {
            clearTimeout(timer);
            fail(
                new Error(
                    `${pusher.label}: subscribe ${name} refused (${error?.status ?? '?'})`,
                ),
            );
        });
    });
}

// ---- provisioning ----------------------------------------------------------------------------------------------------------------

const PROVISION = String.raw`
use App\Models\{User, Widget, Category, AgentPresence};
$d = json_decode(getenv('LOADTEST'), true);
settings()->set('auth.mode', 'fortify');
$category = Category::factory()->create(['slug' => 'lt-'.$d['run'], 'name' => 'Load test']);
$widgets = [];
for ($i = 0; $i < $d['widgets']; $i++) {
    $widget = Widget::factory()->enabled()->withDomains(['loadtest.test'])->create(['name' => 'LT '.$d['run'].' '.$i, 'offline_mode' => 'always_online']);
    $widget->categories()->attach($category->id, ['sort_order' => 0]);
    $widgets[] = $widget->public_key;
}
$agents = [];
for ($i = 0; $i < $d['agents']; $i++) {
    $agent = User::factory()->agent()->create(['name' => 'LT Agent '.$i, 'email' => 'lt-'.$d['run'].'-'.$i.'@loadtest.test', 'max_concurrent_chats' => 1000]);
    $category->users()->attach($agent->id);
    AgentPresence::query()->updateOrCreate(['user_id' => $agent->id], ['status' => 'online', 'last_seen_at' => now(), 'last_heartbeat_at' => now()]);
    $agents[] = ['id' => $agent->id, 'token' => $agent->createToken('lt', ['staff'])->plainTextToken];
}
echo 'JSON:'.json_encode(['category' => $category->slug, 'categoryId' => $category->id, 'widgets' => $widgets, 'agents' => $agents]);
`;

const CLEANUP = String.raw`
use App\Models\{User, Widget, Category};
$d = json_decode(getenv('LOADTEST'), true);
Widget::query()->where('name', 'like', 'LT '.$d['run'].' %')->get()->each(fn ($w) => $w->forceDelete());
Category::withTrashed()->whereKey($d['categoryId'])->get()->each(fn ($c) => $c->forceDelete());
User::query()->where('email', 'like', 'lt-'.$d['run'].'-%@loadtest.test')->get()->each(function ($u) { $u->tokens()->delete(); $u->delete(); });
echo 'JSON:{}';
`;

// ---- resource sampling ------------------------------------------------------------------------------------------------------------

async function discoverReverbPid() {
    if (reverbPid !== null) {
        return reverbPid;
    }

    try {
        const { stdout } = await execFileAsync('lsof', [
            '-ti',
            `tcp:${REVERB_PORT}`,
            '-sTCP:LISTEN',
        ]);

        return Number(stdout.split('\n')[0]) || null;
    } catch {
        return null;
    }
}

async function sampleProcess(pid) {
    try {
        const { stdout } = await execFileAsync('ps', [
            '-o',
            'rss=,%cpu=',
            '-p',
            String(pid),
        ]);
        const [rss, cpu] = stdout.trim().split(/\s+/).map(Number);
        let fds = null;

        try {
            const lsof = await execFileAsync('lsof', ['-p', String(pid)], {
                maxBuffer: 64_000_000,
            });
            fds = lsof.stdout.split('\n').length - 2;
        } catch {
            // no lsof: leave null
        }

        return { rssMb: Math.round(rss / 1024), cpu, fds };
    } catch {
        return null;
    }
}

async function sampleContainer(name) {
    try {
        const { stdout } = await execFileAsync('docker', [
            'stats',
            '--no-stream',
            '--format',
            '{{.CPUPerc}}|{{.MemUsage}}',
            name,
        ]);
        const [cpu, memory] = stdout.trim().split('|');
        const { stdout: fds } = await execFileAsync('docker', [
            'exec',
            name,
            'sh',
            '-c',
            'ls /proc/1/fd 2>/dev/null | wc -l; for p in /proc/[0-9]*; do ls $p/fd 2>/dev/null | wc -l; done | sort -n | tail -1',
        ]);

        return {
            cpu: Number.parseFloat(cpu),
            rssMb: Math.round(Number.parseFloat(memory)),
            fds: Number(fds.trim().split('\n').pop()),
        };
    } catch {
        return null;
    }
}

async function sampleGroup(pattern) {
    try {
        const { stdout } = await execFileAsync('ps', [
            '-A',
            '-o',
            'pid=,%cpu=,rss=,command=',
        ]);
        const rows = stdout
            .split('\n')
            .filter((row) => row.includes(pattern) && !row.includes('grep'));

        return {
            processes: rows.length,
            cpu: rows.reduce(
                (sum, row) => sum + Number(row.trim().split(/\s+/)[1] || 0),
                0,
            ),
            rssMb: Math.round(
                rows.reduce(
                    (sum, row) => sum + Number(row.trim().split(/\s+/)[2] || 0),
                    0,
                ) / 1024,
            ),
        };
    } catch {
        return null;
    }
}

const samples = { reverb: [], web: [], mysql: [] };
let sampling = false;

async function sampleLoop() {
    sampling = true;
    const pid = await discoverReverbPid();
    let tick = 0;

    while (sampling) {
        const at = Math.round((now() - t0) / 1000);

        samples.reverb.push({
            at,
            ...(reverbContainer
                ? await sampleContainer(reverbContainer)
                : pid
                  ? await sampleProcess(pid)
                  : null),
        });
        samples.web.push({ at, ...(await sampleGroup(`php -S`)) });
        samples.mysql.push({ at, ...(await sampleGroup('mysqld')) });
        tick++;
        await sleep(tick % 2 === 0 ? 2500 : 2500);
    }
}

// ---- the run ---------------------------------------------------------------------------------------------------------------------

const t0 = now();
const report = {
    run: RUN,
    parameters: {
        visitors: VISITORS,
        agents: AGENTS,
        widgets: WIDGETS,
        durationS: DURATION,
        intervalS: INTERVAL,
        replyShare: REPLY_SHARE,
        rampPerSecond: RAMP,
        webWorkers: WEB_WORKERS,
        reverb: reverbContainer ?? 'host process',
    },
    machine: {},
};

const visitors = [];
const agents = [];
const counters = {
    visitorsConnected: 0,
    visitorsFailed: 0,
    agentsConnected: 0,
    unexpectedDisconnects: 0,
    messagesSent: 0,
    repliesSent: 0,
    eventsReceived: 0,
    eventsLate: 0,
    claimOk: 0,
    claimLost: 0,
    claimErrors: 0,
    offersSeen: 0,
    takenSeen: 0,
    queueUpdatesSeen: 0,
    errors: [],
};
const latency = {
    visitorMessage: [],
    agentReply: [],
    http: { sessions: [], start: [], send: [], reply: [] },
};
const connectMs = [];
const subscribeMs = [];
const failures = [];
let steady = false;
let running = true;

function noteError(message) {
    if (counters.errors.length < 25) {
        counters.errors.push(message);
    }
}

async function main() {
    const database = assertSafeDatabase();
    console.log(
        `load test ${RUN}: ${VISITORS} visitors, ${AGENTS} agents, ${WIDGETS} widgets, ${DURATION}s, database ${database}`,
    );

    if (args.spawn) {
        start('reverb', 'php', [
            'artisan',
            'reverb:start',
            '--host=0.0.0.0',
            `--port=${REVERB_PORT}`,
        ]);
    }

    if (args.spawn || args['spawn-web']) {
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
    }

    await Promise.all([
        waitForPort(
            REVERB_PORT,
            REVERB_HOST === 'localhost' ? '127.0.0.1' : REVERB_HOST,
        ),
        waitForPort(WEB_PORT),
    ]);

    const fx = await php(PROVISION, {
        run: RUN,
        widgets: WIDGETS,
        agents: AGENTS,
    });

    try {
        void sampleLoop();
        await scenario(fx);
    } finally {
        sampling = false;
        steady = false;
        running = false;

        for (const visitor of visitors) {
            visitor.pusher?.disconnect();
        }

        for (const agent of agents) {
            agent.pusher?.disconnect();
        }

        await php(CLEANUP, { run: RUN, categoryId: fx.categoryId }).catch(
            (error) => console.log(`cleanup failed: ${error.message}`),
        );
    }
}

async function scenario(fx) {
    // ---- the agents --------------------------------------------------------------------------------------------------------------
    for (const [index, agent] of fx.agents.entries()) {
        const pusher = authenticatingPusher(
            `${WEB}/broadcasting/auth`,
            agent.token,
            null,
            `agent ${index}`,
        );
        const entry = {
            index,
            id: agent.id,
            token: agent.token,
            pusher,
            claimed: [],
            conversations: new Map(),
        };

        agents.push(entry);
        pusher.connection.bind('state_change', ({ previous, current }) => {
            if (
                running &&
                previous === 'connected' &&
                current !== 'connected'
            ) {
                counters.unexpectedDisconnects++;
            }
        });
        await connected(pusher);
        const staff = await subscribed(pusher, `private-staff.${agent.id}`);

        await subscribed(pusher, 'presence-staff');
        counters.agentsConnected++;

        staff.channel.bind('chat.offered', (payload) => {
            counters.offersSeen++;

            // One agent takes each chat (a deterministic share), after a short think time, through the API like the dashboard does.
            if (hash(payload.conversation) % AGENTS === index) {
                setTimeout(
                    () => claim(entry, payload.conversation),
                    rand(50, 400),
                );
            }
        });
        staff.channel.bind('chat.taken', () => counters.takenSeen++);
        staff.channel.bind('queue.updated', () => counters.queueUpdatesSeen++);

        await call('presence', 'PUT', '/api/v1/me/presence', {
            token: agent.token,
            body: { status: 'online', automatic: true },
        });
    }

    setInterval(
        () =>
            agents.forEach((agent) =>
                call('heartbeat', 'POST', '/api/v1/me/presence/heartbeat', {
                    token: agent.token,
                    body: { visible: true },
                }),
            ),
        25_000,
    ).unref();

    // ---- the ramp --------------------------------------------------------------------------------------------------------------------
    console.log(
        `agents online (${counters.agentsConnected}); ramping ${VISITORS} visitors at ${RAMP}/s ...`,
    );
    const rampStarted = now();
    let next = 0;
    const workers = Array.from(
        { length: Math.max(8, Math.ceil(RAMP * 2)) },
        async () => {
            while (next < VISITORS) {
                const n = next++;

                await sleep(
                    (n / RAMP) * 1000 - (now() - rampStarted) > 0
                        ? (n / RAMP) * 1000 - (now() - rampStarted)
                        : 0,
                );
                await joinVisitor(n, fx).catch((error) => {
                    counters.visitorsFailed++;
                    failures.push(String(error.message ?? error));
                });

                if ((n + 1) % 100 === 0) {
                    console.log(
                        `  ${counters.visitorsConnected}/${VISITORS} visitors connected (${Math.round((now() - rampStarted) / 1000)} s)`,
                    );
                }
            }
        },
    );

    await Promise.all(workers);
    report.ramp = {
        seconds: Math.round((now() - rampStarted) / 100) / 10,
        connected: counters.visitorsConnected,
        failed: counters.visitorsFailed,
        firstFailures: failures.slice(0, 8),
    };
    console.log(
        `ramp done: ${counters.visitorsConnected} connected, ${counters.visitorsFailed} failed`,
    );

    // Everyone that is going to be claimed is claimed within a few seconds.
    await sleep(3000);

    // ---- the storm -------------------------------------------------------------------------------------------------------------------
    steady = true;
    console.log(
        `message storm for ${DURATION} s (one message per visitor every ~${INTERVAL} s) ...`,
    );
    for (const visitor of visitors.filter((candidate) => candidate.ready)) {
        scheduleSend(visitor);
    }

    await sleep(DURATION * 1000);
    steady = false;
    await sleep(8000); // let in-flight events arrive
    report.storm = { seconds: DURATION };
}

function hash(text) {
    let h = 0;

    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) >>> 0;
    }

    return h;
}

async function claim(agent, conversation) {
    const result = await call(
        'claim',
        'POST',
        `/api/v1/conversations/${conversation}/claim`,
        { token: agent.token },
    );

    if (result.status === 200) {
        counters.claimOk++;
        agent.conversations.set(conversation, true);
    } else if (result.status === 409) {
        counters.claimLost++;
    } else {
        counters.claimErrors++;
        noteError(
            `claim ${result.status} ${JSON.stringify(result.json)?.slice(0, 120)}`,
        );
    }
}

async function joinVisitor(n, fx) {
    const widget = fx.widgets[n % fx.widgets.length];
    const ip = visitorIp(n + 1);
    const visitor = {
        n,
        ip,
        widget,
        ready: false,
        sent: 0,
        pending: new Map(),
        conversation: null,
        token: null,
        pusher: null,
    };
    const session = await call(
        'sessions',
        'POST',
        `/api/v1/public/widgets/${widget}/sessions`,
        {
            ip,
            headers: { Origin: 'https://loadtest.test' },
            body: {
                page: {
                    url: 'https://loadtest.test/p/' + n,
                    title: 'Load test',
                },
                locale: 'en',
            },
        },
    );

    if (session.status !== 201) {
        throw new Error(
            `session ${session.status} ${JSON.stringify(session.json)?.slice(0, 140)}`,
        );
    }

    visitor.token = session.json.data.visitorToken;
    latency.http.sessions.push(session.ms);

    const started = await call(
        'start',
        'POST',
        '/api/v1/public/conversations',
        {
            token: visitor.token,
            ip,
            headers: { Origin: 'https://loadtest.test' },
            body: {
                category: fx.category,
                message: `LT first ${n}`,
                name: `Visitor ${n}`,
                email: `v${n}@loadtest.test`,
            },
        },
    );

    if (started.status !== 201 && started.status !== 200) {
        throw new Error(
            `start ${started.status} ${JSON.stringify(started.json)?.slice(0, 140)}`,
        );
    }

    visitor.conversation =
        started.json.data.ulid ?? started.json.data.conversation?.ulid;
    latency.http.start.push(started.ms);
    visitors.push(visitor);

    const pusher = authenticatingPusher(
        `${WEB}/api/v1/public/broadcasting/auth`,
        visitor.token,
        ip,
        `visitor ${n}`,
    );

    visitor.pusher = pusher;
    pusher.connection.bind('state_change', ({ previous, current }) => {
        if (
            running &&
            visitor.ready &&
            previous === 'connected' &&
            current !== 'connected'
        ) {
            counters.unexpectedDisconnects++;
        }
    });

    connectMs.push(await connected(pusher));
    const result = await subscribed(
        pusher,
        `private-conversation.${visitor.conversation}`,
    );

    subscribeMs.push(result.ms);
    result.channel.bind('message.created', (payload) =>
        onMessage(visitor, payload),
    );
    visitor.ready = true;
    counters.visitorsConnected++;
}

function onMessage(visitor, payload) {
    counters.eventsReceived++;
    const body = payload?.message?.body ?? '';
    const match = /^LT (V|A) (\d+) (\d+(?:\.\d+)?)$/.exec(body);

    if (!match) {
        return;
    }

    const elapsed = now() - Number(match[3]);

    if (match[1] === 'V') {
        latency.visitorMessage.push(elapsed);
        visitor.pending.delete(Number(match[2]));
    } else {
        latency.agentReply.push(elapsed);
    }

    if (elapsed > 5000) {
        counters.eventsLate++;
    }
}

function scheduleSend(visitor) {
    const delay = rand(0, INTERVAL * 1000);

    setTimeout(async function tick() {
        if (!steady) {
            return;
        }

        const seq = ++visitor.sent;
        const sentAt = now();

        visitor.pending.set(seq, sentAt);
        counters.messagesSent++;

        const result = await call(
            'send',
            'POST',
            `/api/v1/public/conversations/${visitor.conversation}/messages`,
            {
                token: visitor.token,
                ip: visitor.ip,
                body: {
                    body: `LT V ${seq} ${sentAt}`,
                    client_msg_id: ulidLike(),
                },
            },
        );

        latency.http.send.push(result.ms);

        if (result.status !== 201 && result.status !== 200) {
            noteError(
                `visitor send ${result.status} ${JSON.stringify(result.json)?.slice(0, 120)}`,
            );
        } else if (Math.random() < REPLY_SHARE) {
            setTimeout(() => reply(visitor), rand(500, 2000));
        }

        setTimeout(tick, INTERVAL * 1000 * rand(0.7, 1.3));
    }, delay);
}

async function reply(visitor) {
    const agent = agents.find((candidate) =>
        candidate.conversations.has(visitor.conversation),
    );

    if (!agent || !steady) {
        return;
    }

    const sentAt = now();

    counters.repliesSent++;
    const result = await call(
        'reply',
        'POST',
        `/api/v1/conversations/${visitor.conversation}/messages`,
        {
            token: agent.token,
            body: {
                body: `LT A ${visitor.sent} ${sentAt}`,
                client_msg_id: ulidLike(),
            },
        },
    );

    latency.http.reply.push(result.ms);

    if (result.status !== 201 && result.status !== 200) {
        noteError(
            `agent reply ${result.status} ${JSON.stringify(result.json)?.slice(0, 120)}`,
        );
    }
}

function ulidLike() {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let out = '0';

    for (let i = 0; i < 25; i++) {
        out += alphabet[Math.floor(Math.random() * 32)];
    }

    return out;
}

try {
    await main();
} catch (error) {
    console.error(`FAILED: ${error?.stack ?? error}`);
    report.fatal = String(error?.message ?? error);
} finally {
    sampling = false;

    report.counters = counters;
    report.connect = { ms: stats(connectMs) };
    report.subscribe = { ms: stats(subscribeMs) };
    report.latencyMs = {
        visitorMessageEndToEnd: stats(latency.visitorMessage),
        agentReplyEndToEnd: stats(latency.agentReply),
    };
    report.http = {
        requests: httpStats.requests,
        networkErrors: httpStats.networkErrors,
        errorCodes: httpStats.errorCodes,
        byStatus: httpStats.byStatus,
        byRoute: httpStats.byRoute,
        durationsMs: Object.fromEntries(
            Object.entries(call.durations).map(([route, values]) => [
                route,
                stats(values),
            ]),
        ),
    };
    report.lost = {
        visitorMessages: [...visitors.values()].reduce(
            (sum, visitor) => sum + visitor.pending.size,
            0,
        ),
    };
    const peak = (list, key) =>
        Math.max(0, ...list.map((sample) => sample[key] ?? 0));

    report.resources = {
        reverb: {
            peakRssMb: peak(samples.reverb, 'rssMb'),
            peakCpuPercent: peak(samples.reverb, 'cpu'),
            peakOpenFds: peak(samples.reverb, 'fds'),
            samples: samples.reverb.length,
        },
        phpWorkers: {
            peakCpuPercentSum: peak(samples.web, 'cpu'),
            peakRssMbSum: peak(samples.web, 'rssMb'),
        },
        mysql: {
            peakCpuPercent: peak(samples.mysql, 'cpu'),
            peakRssMb: peak(samples.mysql, 'rssMb'),
        },
        timeline: samples,
    };
    report.wallSeconds = Math.round((now() - t0) / 1000);

    report.serverOutput = Object.fromEntries(
        children.map((child) => [child.label, child.lines.slice(-8)]),
    );
    report.reverbStillRunning = children.some(
        (child) => child.label === 'reverb',
    )
        ? children.find((child) => child.label === 'reverb').exitCode === null
        : null;
    stopAll();

    const summary = {
        ...report,
        resources: { ...report.resources, timeline: undefined },
    };

    console.log('\n' + JSON.stringify(summary, null, 2));

    if (OUT) {
        writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log(`full report: ${OUT}`);
    }

    process.exit(report.fatal ? 1 : 0);
}
