<?php

/**
 * Runs the hot paths of the chat against a seeded database (scripts/perf/seed-dataset.php) through the application's own HTTP kernel and
 * console commands, captures every SQL statement each one issues and runs EXPLAIN on it (plus EXPLAIN ANALYZE for SELECTs).
 *
 *     php scripts/perf/explain-hot-queries.php [--out=report.md] [--only=history,queue]
 *
 * Everything that writes runs inside a transaction that is rolled back at the end. Only for the dedicated perf database.
 * The report lists per scenario: wall time, number of statements, and per statement the time, the plan (table, access type, key, rows,
 * Extra) with the suspicious ones marked (full scan, filesort, temporary table, many rows examined).
 */

use App\Domain\Chat\Realtime\Jobs\BroadcastQueueCounts;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Contracts\Console\Kernel as ConsoleKernel;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';

foreach (['BROADCAST_CONNECTION' => 'null', 'QUEUE_CONNECTION' => 'sync', 'CACHE_STORE' => 'file', 'SESSION_DRIVER' => 'file', 'APP_INSTALLED' => 'true', 'PRESENCE_STORE' => 'database', 'APP_ENV' => 'local', 'APP_DEBUG' => 'false'] as $key => $value) {
    putenv($key.'='.$value);
    $_ENV[$key] = $value;
    $_SERVER[$key] = $value;
}

$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(ConsoleKernel::class)->bootstrap();

$options = getopt('', ['out::', 'only::']);
$out = (string) ($options['out'] ?? '');
$only = array_filter(explode(',', (string) ($options['only'] ?? '')));
$database = (string) DB::connection()->getDatabaseName();

if (! preg_match('/^chatfeature_(p7_|perf)/', $database)) {
    fwrite(STDERR, "Refusing to run against \"{$database}\".\n");
    exit(1);
}

DB::statement("SET time_zone = '+00:00'");
DB::statement('SET SESSION innodb_ft_enable_stopword = ON');

$http = $app->make(HttpKernel::class);
$report = [];
$counts = DB::select('select (select count(*) from conversations) c, (select count(*) from messages) m, (select count(*) from visitors) v, (select count(*) from wa_chats) w, (select count(*) from wa_messages) wm')[0];
$report[] = sprintf("# Hot query review on %s\n\nDataset: %s conversations, %s messages, %s visitors, %s WhatsApp chats, %s WhatsApp messages. MySQL %s.\n", $database, number_format($counts->c), number_format($counts->m), number_format($counts->v), number_format($counts->w), number_format($counts->wm), DB::selectOne('select version() v')->v);

// ---- actors ----------------------------------------------------------------------------------------------------------------------
$admin = User::query()->where('is_admin', true)->orderBy('id')->firstOrFail();
$agent = User::query()->where('is_agent', true)->where('is_admin', false)->whereExists(fn ($q) => $q->select(DB::raw(1))->from('conversations')->whereColumn('conversations.assigned_agent_id', 'users.id')->where('status', 'active'))->orderBy('id')->firstOrFail();
$adminToken = $admin->createToken('perf', ['staff'])->plainTextToken;
$agentToken = $agent->createToken('perf', ['staff'])->plainTextToken;
$widget = Widget::query()->orderBy('id')->firstOrFail();

foreach (Widget::query()->get() as $each) {
    if (! WidgetDomain::query()->where('widget_id', $each->id)->exists()) {
        WidgetDomain::factory()->for($each)->host('perf.test')->create();
    }
}

$openChat = DB::table('conversations')->where('status', 'active')->where('type', 'live')->where('assigned_agent_id', $agent->id)->orderByDesc('id')->first();
$queuedChat = DB::table('conversations')->where('status', 'queued')->where('type', 'live')->orderBy('id')->first();
$closedChat = DB::table('conversations')->where('status', 'closed')->orderByDesc('id')->first();
$visitorOfOpen = $openChat === null ? null : DB::table('conversations')->where('id', $openChat->id)->value('visitor_id');
$visitorTokenOf = function (int $visitorId): string {
    $index = (int) DB::table('visitors')->where('id', '<=', $visitorId)->count();

    return 'vt_'.substr(hash('sha256', 'perf-token-'.$index), 0, 40);
};

// ---- machinery -------------------------------------------------------------------------------------------------------------------
$call = function (string $method, string $uri, array $params = [], ?string $token = null, array $headers = []) use ($http, $app): int {
    $server = ['HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => '203.0.113.'.mt_rand(1, 250)];

    if ($token !== null) {
        $server['HTTP_AUTHORIZATION'] = 'Bearer '.$token;
    }

    foreach ($headers as $name => $value) {
        $server['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;
    }

    $app['auth']->forgetGuards();
    $request = Request::create($uri, $method, $method === 'GET' ? $params : [], [], [], $server, $method === 'GET' ? null : json_encode($params));

    if ($method !== 'GET') {
        $request->headers->set('Content-Type', 'application/json');
    }

    $response = $http->handle($request);
    $status = $response->getStatusCode();
    $http->terminate($request, $response);

    return $status;
};

/** Plan rows of EXPLAIN, flattened to one line per table. */
$plan = function (string $sql, array $bindings): array {
    $verb = strtolower(strtok(ltrim($sql), " \n\t"));

    if (! in_array($verb, ['select', 'update', 'delete', 'insert'], true)) {
        return [[], null];
    }

    try {
        $rows = DB::select('EXPLAIN FORMAT=TRADITIONAL '.$sql, $bindings);
    } catch (Throwable $exception) {
        return [[['error' => substr($exception->getMessage(), 0, 160)]], null];
    }

    $analyze = null;

    if ($verb === 'select') {
        try {
            $text = DB::select('EXPLAIN ANALYZE '.$sql, $bindings);
            $first = (array) ($text[0] ?? []);
            $analyze = (string) reset($first);
        } catch (Throwable) {
            $analyze = null;
        }
    }

    return [array_map(fn ($row) => (array) $row, $rows), $analyze];
};

$suspicious = function (array $row): array {
    $notes = [];

    if (($row['type'] ?? '') === 'ALL') {
        $notes[] = 'FULL SCAN';
    }

    if (str_contains((string) ($row['Extra'] ?? ''), 'filesort')) {
        $notes[] = 'filesort';
    }

    if (str_contains((string) ($row['Extra'] ?? ''), 'temporary')) {
        $notes[] = 'temporary';
    }

    if ((int) ($row['rows'] ?? 0) > 5000 && ($row['type'] ?? '') !== 'const') {
        $notes[] = 'rows~'.$row['rows'];
    }

    return $notes;
};

$scenarios = [];
$scenario = function (string $id, string $title, Closure $run, bool $writes = false) use (&$scenarios): void {
    $scenarios[$id] = compact('title', 'run', 'writes');
};

// ---- the scenarios ---------------------------------------------------------------------------------------------------------------
$scenario('queue', 'Staff queue listing (agent and admin): GET /conversations/queue', function () use ($call, $agentToken, $adminToken): void {
    $call('GET', '/api/v1/conversations/queue', [], $agentToken);
    $call('GET', '/api/v1/conversations/queue', [], $adminToken);
});

$scenario('mine', 'Dashboard hydrate (agent): my active live chats, offline tickets queued and active', function () use ($call, $agentToken): void {
    $call('GET', '/api/v1/conversations', ['status' => ['active'], 'type' => 'live', 'limit' => 100], $agentToken);
    $call('GET', '/api/v1/conversations', ['status' => ['queued'], 'type' => 'offline', 'limit' => 100], $agentToken);
    $call('GET', '/api/v1/conversations', ['status' => ['active'], 'type' => 'offline', 'limit' => 100], $agentToken);
});

$scenario('mine-admin', 'Dashboard hydrate (admin): the same lists for an administrator', function () use ($call, $adminToken): void {
    $call('GET', '/api/v1/conversations', ['status' => ['active'], 'type' => 'live', 'limit' => 100], $adminToken);
    $call('GET', '/api/v1/conversations', ['status' => ['queued'], 'type' => 'offline', 'limit' => 100], $adminToken);
});

$scenario('history', 'Admin history: newest first, filters (status, widget, category, date range, agent), second page', function () use ($call, $adminToken, $widget, $agent): void {
    $call('GET', '/api/v1/conversations', ['limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['status' => ['closed', 'ended', 'missed'], 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['widget' => $widget->ulid, 'from' => date('Y-m-d', strtotime('-90 days')), 'to' => date('Y-m-d'), 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['agent' => (string) $agent->id, 'status' => ['closed'], 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['type' => 'offline', 'status' => ['closed'], 'limit' => 25], $adminToken);
});

$scenario('history-search', 'History search (q): a message word, a rare word, a ticket number, an e-mail fragment', function () use ($call, $adminToken, $agentToken): void {
    $call('GET', '/api/v1/conversations', ['q' => 'refund', 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['q' => 'bamonro', 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['q' => 'T000012345', 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['q' => 'smith12', 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['q' => 'nothingmatchesthis', 'limit' => 25], $adminToken);
    $call('GET', '/api/v1/conversations', ['q' => 'refund invoice', 'limit' => 25], $agentToken);
});

$scenario('export', 'History export (admin, JSON)', function () use ($call, $adminToken): void {
    $call('GET', '/api/v1/conversations/export', ['status' => ['closed'], 'from' => date('Y-m-d', strtotime('-7 days')), 'format' => 'json'], $adminToken);
});

$scenario('conversation', 'Open one conversation (staff): show, messages (first page and after_seq), transfer targets', function () use ($call, $agentToken, $openChat): void {
    if ($openChat === null) {
        return;
    }

    $ulid = $openChat->ulid;
    $call('GET', '/api/v1/conversations/'.$ulid, [], $agentToken);
    $call('GET', '/api/v1/conversations/'.$ulid.'/messages', [], $agentToken);
    $call('GET', '/api/v1/conversations/'.$ulid.'/messages', ['after_seq' => max(0, $openChat->last_seq - 3)], $agentToken);
    $call('GET', '/api/v1/conversations/'.$ulid.'/transfer-targets', [], $agentToken);
});

$scenario('send', 'Staff sends a message, receipts, typing (writes, rolled back)', function () use ($call, $agentToken, $openChat): void {
    if ($openChat === null) {
        return;
    }

    $ulid = $openChat->ulid;
    $call('POST', '/api/v1/conversations/'.$ulid.'/messages', ['body' => 'Hello from the perf run', 'client_msg_id' => strtoupper(substr(bin2hex(random_bytes(13)), 0, 26))], $agentToken);
    $call('POST', '/api/v1/conversations/'.$ulid.'/receipts', ['up_to_seq' => $openChat->last_seq, 'type' => 'seen'], $agentToken);
}, writes: true);

$scenario('claim', 'First accept wins: claim a queued chat (writes, rolled back)', function () use ($call, $agent, $agentToken): void {
    $chat = DB::table('conversations')->join('conversation_agent_alerts as a', 'a.conversation_id', '=', 'conversations.id')
        ->where('conversations.status', 'queued')->where('a.user_id', $agent->id)->whereNull('a.responded_at')->orderBy('conversations.id')->first(['conversations.ulid']);

    if ($chat !== null) {
        $call('POST', '/api/v1/conversations/'.$chat->ulid.'/claim', [], $agentToken);
    }
}, writes: true);

$scenario('visitor', 'Visitor panel: conversation, messages after_seq, widget availability, session', function () use ($call, $widget, $visitorTokenOf, $visitorOfOpen, $openChat): void {
    if ($openChat !== null && $visitorOfOpen !== null) {
        $token = $visitorTokenOf((int) $visitorOfOpen);
        $call('GET', '/api/v1/public/conversation', [], $token);
        $call('GET', '/api/v1/public/conversations/'.$openChat->ulid.'/messages', ['after_seq' => max(0, $openChat->last_seq - 3)], $token);
    }

    Cache::flush();
    $call('GET', '/api/v1/public/widgets/'.$widget->public_key.'/availability', [], null, ['Origin' => 'https://perf.test']);
    $call('GET', '/api/v1/public/widgets/'.$widget->public_key.'/config', [], null, ['Origin' => 'https://perf.test']);

    if ($visitorOfOpen !== null) {
        $call('POST', '/api/v1/public/widgets/'.$widget->public_key.'/sessions', ['page' => ['url' => 'https://perf.test/x']], $visitorTokenOf((int) $visitorOfOpen), ['Origin' => 'https://perf.test']);
    }
}, writes: true);

$scenario('start-chat', 'Visitor starts a chat: conversation insert, routing offers (writes, rolled back)', function () use ($call, $widget, $visitorTokenOf): void {
    $visitor = DB::table('visitors')->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('conversations')->whereColumn('conversations.visitor_id', 'visitors.id')->whereIn('status', ['queued', 'active']))->where('widget_id', $widget->id)->orderByDesc('id')->first();
    $category = DB::table('categories')->orderBy('id')->first();

    if ($visitor === null) {
        return;
    }

    $call('POST', '/api/v1/public/conversations', ['category' => $category->slug, 'message' => 'Hi, I need help with my order'], $visitorTokenOf((int) $visitor->id), ['Origin' => 'https://perf.test']);
}, writes: true);

$scenario('queue-counts', 'queue.updated job: one visibleTo count per staff member', function (): void {
    BroadcastQueueCounts::dispatchSync();
});

$scenario('sweeps', 'Scheduled sweeps (writes, rolled back): expire-queued, offer-waves, close-idle, close-unrated, presence, realtime, prune-visitor-sessions', function (): void {
    foreach (['chat:expire-queued', 'chat:offer-waves', 'chat:close-idle', 'chat:close-unrated', 'chat:presence-sweep', 'chat:realtime-sweep', 'chat:prune-visitor-sessions'] as $command) {
        Artisan::call($command);
    }
}, writes: true);

$scenario('whatsapp', 'WhatsApp inbox (admin): chats, search, transcript, unread', function () use ($call, $adminToken): void {
    $call('GET', '/api/v1/whatsapp/chats', ['limit' => 30], $adminToken);
    $call('GET', '/api/v1/whatsapp/chats', ['status' => 'archived', 'limit' => 30], $adminToken);
    $call('GET', '/api/v1/whatsapp/chats', ['q' => 'refund', 'limit' => 30], $adminToken);
    $call('GET', '/api/v1/whatsapp/chats', ['q' => '4915100', 'limit' => 30], $adminToken);
    $chat = DB::table('wa_chats')->orderByDesc('id')->first();

    if ($chat !== null) {
        $call('GET', '/api/v1/whatsapp/chats/'.$chat->ulid, [], $adminToken);
        $call('GET', '/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', [], $adminToken);
    }
});

// ---- run -------------------------------------------------------------------------------------------------------------------------
foreach ($scenarios as $id => $definition) {
    if ($only !== [] && ! in_array($id, $only, true)) {
        continue;
    }

    DB::flushQueryLog();
    DB::enableQueryLog();
    $writes = $definition['writes'];

    if ($writes) {
        DB::beginTransaction();
    }

    $started = microtime(true);

    try {
        ($definition['run'])();
    } catch (Throwable $exception) {
        $report[] = "## {$id}\n\nFAILED: ".$exception->getMessage()."\n";
    }

    $wall = (microtime(true) - $started) * 1000;
    $log = DB::getQueryLog();
    DB::disableQueryLog();

    // The plans are taken before the rollback: a transaction that wrote rows is what the next statement sees.
    $distinct = [];

    foreach ($log as $entry) {
        $key = preg_replace('/\s+/', ' ', $entry['query']);
        $distinct[$key] ??= ['sql' => $entry['query'], 'bindings' => $entry['bindings'], 'time' => 0.0, 'count' => 0, 'max' => 0.0];
        $distinct[$key]['time'] += $entry['time'];
        $distinct[$key]['count']++;
        $distinct[$key]['max'] = max($distinct[$key]['max'], $entry['time']);
    }

    uasort($distinct, fn ($a, $b) => $b['time'] <=> $a['time']);
    $lines = [sprintf("## %s\n\n%s\n\nwall %.0f ms, %d statements (%d distinct), %.0f ms in SQL.\n", $id, $definition['title'], $wall, count($log), count($distinct), array_sum(array_column($log, 'time')))];

    foreach ($distinct as $statement) {
        [$rows, $analyze] = $plan($statement['sql'], $statement['bindings']);
        $flags = [];

        foreach ($rows as $row) {
            array_push($flags, ...$suspicious($row));
        }

        $lines[] = sprintf("- **%.1f ms** x%d (max %.1f ms)%s\n  `%s`", $statement['time'], $statement['count'], $statement['max'], $flags === [] ? '' : ' **['.implode(', ', array_unique($flags)).']**', mb_strimwidth(preg_replace('/\s+/', ' ', $statement['sql']), 0, 420, '…'));

        foreach ($rows as $row) {
            $lines[] = sprintf('  - %s: type=%s key=%s rows=%s filtered=%s extra=%s', $row['table'] ?? '?', $row['type'] ?? '-', $row['key'] ?? 'NULL', $row['rows'] ?? '-', $row['filtered'] ?? '-', $row['Extra'] ?? '');
        }

        if ($analyze !== null && $statement['time'] > 20) {
            $lines[] = '  - analyze: '.mb_strimwidth(str_replace("\n", ' ', $analyze), 0, 700, '…');
        }
    }

    $report[] = implode("\n", $lines)."\n";

    if ($writes) {
        DB::rollBack();
    }

    fwrite(STDERR, sprintf("%-14s %6.0f ms  %3d statements\n", $id, $wall, count($log)));
}

$report[] = "\n---\nTokens created for the run are removed.\n";
$admin->tokens()->delete();
$agent->tokens()->delete();

$text = implode("\n", $report);

if ($out !== '') {
    file_put_contents($out, $text);
    fwrite(STDERR, "Report written to {$out}\n");
} else {
    echo $text;
}
