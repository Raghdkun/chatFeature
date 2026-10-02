<?php

/**
 * Generates a large, realistic chat dataset for the query / index review (P7, docs/runbook.md "Query review").
 *
 *     php scripts/perf/seed-dataset.php [--conversations=50000] [--messages=500000] [--whatsapp-chats=5000] [--wa-messages=50000]
 *
 * Rows are written with bulk INSERTs (never through the application's actions): visitors with one session each (deterministic bearer
 * tokens, see `perfToken()`), conversations over the last 12 months in every status and both types, messages with real words (so
 * FULLTEXT and LIKE searches have something to find), events, offers, ratings, attachments rows (no files), agent presence and a
 * WhatsApp inbox. Only for a dedicated development database: it refuses anything else and a database that already holds a dataset.
 */

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

require __DIR__.'/../../vendor/autoload.php';

putenv('BROADCAST_CONNECTION=null');
$_ENV['BROADCAST_CONNECTION'] = 'null';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

/** The bearer token of the visitor with this sequence number (the harness derives the same token to call the public API). */
function perfToken(int $n): string
{
    return 'vt_'.substr(hash('sha256', 'perf-token-'.$n), 0, 40);
}

$options = getopt('', ['conversations::', 'messages::', 'whatsapp-chats::', 'wa-messages::']);
$conversations = (int) ($options['conversations'] ?? 50_000);
$messages = (int) ($options['messages'] ?? 500_000);
$waChats = (int) ($options['whatsapp-chats'] ?? 5_000);
$waMessages = (int) ($options['wa-messages'] ?? 50_000);
$visitorCount = (int) max(1, $conversations * 0.6);

$database = (string) DB::connection()->getDatabaseName();

if (! preg_match('/^chatfeature_(p7_|perf)/', $database) || app()->isProduction()) {
    fwrite(STDERR, "Refusing to seed database \"{$database}\": use a dedicated chatfeature_p7_* / chatfeature_perf* database.\n");
    exit(1);
}

if (DB::table('conversations')->count() > 1000) {
    fwrite(STDERR, "The database already holds a dataset ({$database}); wipe it first (php artisan db:wipe).\n");
    exit(1);
}

// Wall-clock strings are written as UTC: a MySQL session in a local time zone would refuse the ones inside its DST gap.
DB::statement("SET time_zone = '+00:00'");
mt_srand(20261210);
$started = microtime(true);
$say = function (string $line) use ($started): void {
    printf("[%6.1fs] %s\n", microtime(true) - $started, $line);
};
$insert = function (string $table, array $rows) {
    foreach (array_chunk($rows, 1500) as $chunk) {
        DB::table($table)->insert($chunk);
    }
};
$stamp = fn (int $unix): string => date('Y-m-d H:i:s', $unix);
$pick = fn (array $values) => $values[mt_rand(0, count($values) - 1)];

settings()->set('auth.mode', 'fortify');

// ---- people, widgets, categories ----------------------------------------------------------------------------------------------
$admins = User::factory()->admin()->count(3)->create();
$agents = User::factory()->agent()->count(40)->create(['max_concurrent_chats' => 5]);
$widgets = Widget::factory()->enabled()->count(3)->create(['offline_mode' => 'always_online']);
$categories = collect(['billing', 'sales', 'support', 'shipping', 'returns', 'other'])->map(fn (string $slug) => Category::factory()->create(['slug' => 'perf-'.$slug, 'name' => ucfirst($slug)]));

foreach ($widgets as $widget) {
    foreach ($categories as $index => $category) {
        $widget->categories()->attach($category->id, ['sort_order' => $index]);
    }
}

foreach ($agents as $index => $agent) {
    // Every agent serves 2 or 3 categories.
    foreach ($categories->shuffle()->take(2 + ($index % 2)) as $category) {
        $agent->categories()->attach($category->id);
    }
}

$agentIds = $agents->pluck('id')->all();
$widgetIds = $widgets->pluck('id')->all();
$categoryIds = $categories->pluck('id')->all();
$say(sprintf('%d agents, %d admins, %d widgets, %d categories', count($agentIds), count($admins), count($widgetIds), count($categoryIds)));

$now = time();
$insert('agent_presence', array_map(fn (int $id): array => [
    'user_id' => $id, 'status' => $id % 3 === 0 ? 'away' : 'online', 'is_manual' => false,
    'last_seen_at' => $stamp($now), 'last_heartbeat_at' => $stamp($now - mt_rand(0, 60)), 'created_at' => $stamp($now), 'updated_at' => $stamp($now),
], $agentIds));

// ---- visitors and their sessions ----------------------------------------------------------------------------------------------
$firstNames = ['Alex', 'Sam', 'Maria', 'Omar', 'Lena', 'Chen', 'Ivan', 'Aisha', 'Noah', 'Mia', 'Yusuf', 'Sofia', 'Liam', 'Nora', 'Karim', 'Eva'];
$lastNames = ['Smith', 'Garcia', 'Khan', 'Muller', 'Rossi', 'Haddad', 'Novak', 'Silva', 'Ito', 'Okafor', 'Larsen', 'Dubois', 'Costa', 'Petrov'];
$visitorRows = [];
$sessionRows = [];

for ($n = 1; $n <= $visitorCount; $n++) {
    $seen = $now - mt_rand(0, 365 * 86_400);
    $first = $pick($firstNames);
    $last = $pick($lastNames);
    $visitorRows[] = [
        'ulid' => (string) Str::ulid(), 'workspace_id' => null, 'widget_id' => $widgetIds[$n % count($widgetIds)], 'external_id' => $n % 5 === 0 ? 'cust-'.$n : null,
        'verified' => $n % 5 === 0, 'name' => $first.' '.$last, 'email' => strtolower($first.'.'.$last.$n).'@example.test', 'phone' => '+49 30 '.mt_rand(100000, 999999),
        'meta' => null, 'first_seen_at' => $stamp($seen - 86_400), 'last_seen_at' => $stamp($seen), 'created_at' => $stamp($seen - 86_400), 'updated_at' => $stamp($seen),
    ];
}

$insert('visitors', $visitorRows);
unset($visitorRows);
$visitors = DB::table('visitors')->orderBy('id')->get(['id', 'widget_id'])->all();
$say(count($visitors).' visitors');

foreach ($visitors as $index => $visitor) {
    $created = $now - mt_rand(0, 365 * 86_400);
    $sessionRows[] = [
        'ulid' => (string) Str::ulid(), 'visitor_id' => $visitor->id, 'widget_id' => $visitor->widget_id, 'token_hash' => hash('sha256', perfToken($index + 1)),
        'expires_at' => $stamp($now + 30 * 86_400), 'revoked_at' => null, 'last_used_at' => $stamp($created), 'page_url' => 'https://shop.example.test/p/'.$index,
        'page_title' => 'Product '.$index, 'referrer' => null, 'user_agent' => 'Mozilla/5.0 perf', 'locale' => 'en', 'network_hash' => substr(hash('sha256', 'net'.($index % 4000)), 0, 64),
        'created_at' => $stamp($created), 'updated_at' => $stamp($created),
    ];
}

$insert('visitor_sessions', $sessionRows);
unset($sessionRows);
$sessionIdByVisitor = DB::table('visitor_sessions')->pluck('id', 'visitor_id')->all();
$say(count($sessionIdByVisitor).' visitor sessions');

// ---- conversations ------------------------------------------------------------------------------------------------------------
$words = [];
$syllables = ['ba', 'ro', 'ki', 'lu', 'ma', 'ne', 'to', 'sa', 'vi', 'dor', 'pen', 'tar', 'mon', 'lex', 'qui', 'zen'];

for ($w = 0; $w < 3000; $w++) {
    $parts = mt_rand(1, 3);
    $word = '';

    for ($p = 0; $p < $parts; $p++) {
        $word .= $syllables[mt_rand(0, count($syllables) - 1)];
    }

    $words[] = $word;
}

$common = ['order', 'refund', 'invoice', 'delivery', 'password', 'account', 'payment', 'shipping', 'return', 'discount', 'subscription', 'cancel', 'warranty', 'address', 'login'];
$sentence = function () use ($words, $common, $pick): string {
    $count = mt_rand(3, 14);
    $out = [];

    for ($i = 0; $i < $count; $i++) {
        $out[] = mt_rand(1, 6) === 1 ? $pick($common) : $words[mt_rand(0, count($words) - 1)];
    }

    return ucfirst(implode(' ', $out)).'.';
};

$conversationRows = [];
$plan = []; // per conversation: [status, type, created, messageCount]
$visitorIds = array_map(fn ($visitor) => $visitor->id, $visitors);

for ($n = 1; $n <= $conversations; $n++) {
    $roll = mt_rand(1, 1000);
    [$status, $type] = match (true) {
        $roll <= 6 => ['queued', 'live'],
        $roll <= 20 => ['queued', 'offline'],
        $roll <= 50 => ['active', 'live'],
        $roll <= 60 => ['active', 'offline'],
        $roll <= 110 => ['ended', 'live'],
        $roll <= 160 => ['missed', 'live'],
        $roll <= 230 => ['closed', 'offline'],
        default => ['closed', 'live'],
    };
    $open = in_array($status, ['queued', 'active', 'ended'], true);
    $created = $open ? $now - mt_rand(0, 3 * 3600) : $now - mt_rand(3 * 3600, 365 * 86_400);
    $visitorId = $visitorIds[mt_rand(0, count($visitorIds) - 1)];
    $count = $status === 'queued' || $status === 'missed' ? mt_rand(1, 2) : mt_rand(2, 18);
    $lastMessageAt = $created + $count * 30;
    $agentId = $status === 'queued' || $status === 'missed' ? null : $agentIds[mt_rand(0, count($agentIds) - 1)];
    $plan[$n] = [$status, $type, $created, $count, $visitorId, $agentId];
    $conversationRows[] = [
        'ulid' => (string) Str::ulid(), 'workspace_id' => null, 'widget_id' => $widgetIds[$visitorId % count($widgetIds)], 'visitor_id' => $visitorId,
        'visitor_session_id' => $sessionIdByVisitor[$visitorId] ?? null, 'category_id' => $categoryIds[mt_rand(0, count($categoryIds) - 1)],
        'ticket_no' => 'T'.str_pad((string) $n, 9, '0', STR_PAD_LEFT), 'type' => $type, 'status' => $status, 'assigned_agent_id' => $agentId,
        'last_seq' => $count, 'claim_version' => $agentId === null ? 0 : 1, 'wave' => 1,
        'queued_at' => $stamp($created), 'queue_expires_at' => $status === 'queued' ? $stamp($now + mt_rand(5, 85)) : $stamp($created + 90),
        'claimed_at' => $agentId === null ? null : $stamp($created + 20), 'ended_at' => in_array($status, ['ended', 'closed'], true) ? $stamp($lastMessageAt) : null,
        'closed_at' => $status === 'closed' || $status === 'missed' ? $stamp($lastMessageAt + 10) : null, 'ended_by' => in_array($status, ['ended', 'closed'], true) ? 'agent' : null,
        'close_reason' => $status === 'closed' ? 'rated' : ($status === 'missed' ? 'timeout' : null),
        'last_activity_at' => $stamp($lastMessageAt), 'idle_expires_at' => $status === 'active' ? $stamp($now + mt_rand(600, 7000)) : null,
        'last_message_at' => $stamp($lastMessageAt), 'last_message_preview' => 'Preview '.$n, 'unseen_by_agent' => $status === 'active' ? mt_rand(0, 3) : 0, 'unseen_by_visitor' => 0,
        'rating_requested' => $status === 'ended', 'rating_window_expires_at' => $status === 'ended' ? $stamp($now + mt_rand(60, 3000)) : null,
        'created_at' => $stamp($created), 'updated_at' => $stamp($lastMessageAt),
    ];
}

$insert('conversations', $conversationRows);
unset($conversationRows);
$say($conversations.' conversations');

$idByTicket = DB::table('conversations')->orderBy('id')->pluck('id');
$firstId = (int) $idByTicket->first();

// ---- messages, events, offers, ratings, attachments ---------------------------------------------------------------------------
$target = $messages;
$planned = array_sum(array_column($plan, 3));
$scale = $planned > 0 ? $target / $planned : 1.0;
$messageRows = [];
$eventRows = [];
$offerRows = [];
$ratingRows = [];
$total = 0;
$written = 0;

foreach ($plan as $n => [$status, $type, $created, $count, $visitorId, $agentId]) {
    $conversationId = $firstId + $n - 1;
    $count = max(1, (int) round($count * $scale));

    for ($seq = 1; $seq <= $count; $seq++) {
        $sender = $seq === 1 ? 'visitor' : ($seq % 2 === 0 ? 'agent' : 'visitor');
        $isSystem = $seq === 2 && $agentId !== null && $type === 'live';
        $messageRows[] = [
            'ulid' => (string) Str::ulid(), 'conversation_id' => $conversationId, 'seq' => $seq, 'sender_type' => $isSystem ? 'system' : ($agentId === null && $sender === 'agent' ? 'visitor' : $sender),
            'sender_user_id' => $sender === 'agent' && ! $isSystem ? $agentId : null, 'type' => $isSystem ? 'system' : 'text', 'body' => $isSystem ? 'An agent joined the chat.' : $sentence(),
            'client_msg_id' => $sender === 'visitor' && ! $isSystem ? substr(strtoupper(bin2hex(random_bytes(13))), 0, 26) : null,
            'delivered_at' => $stamp($created + $seq * 30 + 1), 'seen_at' => $stamp($created + $seq * 30 + 4), 'created_at' => $stamp($created + $seq * 30),
        ];
        $total++;
    }

    $eventRows[] = ['conversation_id' => $conversationId, 'type' => 'created', 'actor_type' => 'visitor', 'actor_id' => $visitorId, 'payload' => null, 'created_at' => $stamp($created)];

    if ($agentId !== null) {
        $eventRows[] = ['conversation_id' => $conversationId, 'type' => 'claimed', 'actor_type' => 'agent', 'actor_id' => $agentId, 'payload' => '{"wave":1}', 'created_at' => $stamp($created + 20)];
    }

    if (in_array($status, ['closed', 'ended'], true)) {
        $eventRows[] = ['conversation_id' => $conversationId, 'type' => 'ended', 'actor_type' => 'agent', 'actor_id' => $agentId, 'payload' => null, 'created_at' => $stamp($created + $count * 30)];
    }

    if ($status === 'queued' && $type === 'live') {
        foreach (array_slice($agentIds, mt_rand(0, 30), 6) as $offered) {
            $offerRows[] = ['conversation_id' => $conversationId, 'user_id' => $offered, 'wave' => 1, 'offered_at' => $stamp($created), 'expires_at' => $stamp($now + mt_rand(5, 85)), 'responded_at' => null, 'response' => null];
        }
    } elseif ($status === 'closed' && $type === 'live' && mt_rand(1, 5) === 1) {
        foreach (array_slice($agentIds, mt_rand(0, 30), 3) as $index => $offered) {
            $offerRows[] = ['conversation_id' => $conversationId, 'user_id' => $offered, 'wave' => 1, 'offered_at' => $stamp($created), 'expires_at' => $stamp($created + 90), 'responded_at' => $stamp($created + 20), 'response' => $index === 0 ? 'accepted' : 'taken'];
        }
    }

    if ($status === 'closed' && mt_rand(1, 100) <= 40) {
        $ratingRows[] = ['conversation_id' => $conversationId, 'score' => mt_rand(1, 5), 'comment' => mt_rand(1, 4) === 1 ? $sentence() : null, 'created_at' => $stamp($created + $count * 30 + 30)];
    }

    if (count($messageRows) >= 20_000) {
        $insert('messages', $messageRows);
        $written += count($messageRows);
        $messageRows = [];
        $say(sprintf('%d messages', $written));
    }
}

$insert('messages', $messageRows);
$written += count($messageRows);
$insert('conversation_events', $eventRows);
$insert('conversation_agent_alerts', $offerRows);
$insert('ratings', $ratingRows);
$say(sprintf('%d messages, %d events, %d offers, %d ratings', $written, count($eventRows), count($offerRows), count($ratingRows)));

$attachmentRows = [];

foreach (DB::table('messages')->where('type', 'text')->where('sender_type', 'visitor')->inRandomOrder()->limit(5000)->get(['id', 'conversation_id']) as $message) {
    $attachmentRows[] = [
        'ulid' => (string) Str::ulid(), 'conversation_id' => $message->conversation_id, 'message_id' => $message->id, 'uploader_type' => 'visitor', 'uploader_user_id' => null, 'disk' => 'local',
        'path' => 'chat/perf/'.Str::random(20).'.jpg', 'thumb_path' => null, 'mime' => 'image/jpeg', 'size' => mt_rand(20_000, 400_000), 'width' => 800, 'height' => 600,
        'sha256' => hash('sha256', Str::random(16)), 'original_name' => 'photo.jpg', 'position' => 0, 'created_at' => $stamp($now - mt_rand(0, 365 * 86_400)),
    ];
}

$insert('attachments', $attachmentRows);
$say(count($attachmentRows).' attachments');

// ---- WhatsApp inbox -----------------------------------------------------------------------------------------------------------
$sessionId = DB::table('whatsapp_sessions')->insertGetId([
    'ulid' => (string) Str::ulid(), 'name' => 'perf-line', 'engine' => 'whatsapp-web.js', 'status' => 'ready', 'phone_e164' => '+4930000000', 'created_at' => $stamp($now), 'updated_at' => $stamp($now),
]);
$chatRows = [];

for ($n = 1; $n <= $waChats; $n++) {
    $last = $now - mt_rand(0, 200 * 86_400);
    $chatRows[] = [
        'ulid' => (string) Str::ulid(), 'workspace_id' => null, 'session_id' => $sessionId, 'chat_id' => '49151'.str_pad((string) $n, 7, '0', STR_PAD_LEFT).'@c.us',
        'phone_e164' => '+49151'.str_pad((string) $n, 7, '0', STR_PAD_LEFT), 'push_name' => $pick($firstNames).' '.$pick($lastNames), 'is_group' => false, 'status' => $n % 9 === 0 ? 'archived' : 'open',
        'widget_id' => null, 'visitor_id' => null, 'category_id' => null, 'handoff_ticket_id' => null, 'last_inbound_at' => $stamp($last), 'last_message_at' => $stamp($last),
        'last_message_preview' => 'Preview '.$n, 'unread_by_admin' => $n % 7 === 0 ? mt_rand(1, 4) : 0, 'inbound_initiated' => true, 'created_at' => $stamp($last - 3600), 'updated_at' => $stamp($last),
    ];
}

$insert('wa_chats', $chatRows);
$firstChat = (int) DB::table('wa_chats')->min('id');
$waRows = [];

for ($n = 1; $n <= $waMessages; $n++) {
    $chat = $firstChat + mt_rand(0, $waChats - 1);
    $at = $now - mt_rand(0, 200 * 86_400);
    $waRows[] = [
        'ulid' => (string) Str::ulid(), 'wa_chat_id' => $chat, 'direction' => $n % 3 === 0 ? 'outbound' : 'inbound', 'wa_message_id' => 'false_'.$n.'_'.substr(md5((string) $n), 0, 12),
        'type' => 'text', 'body' => $sentence(), 'sent_by_user_id' => null, 'status' => 'received', 'wa_timestamp' => $stamp($at), 'raw' => null, 'created_at' => $stamp($at), 'updated_at' => $stamp($at),
    ];

    if (count($waRows) >= 10_000) {
        $insert('wa_messages', $waRows);
        $waRows = [];
    }
}

$insert('wa_messages', $waRows);
$say(sprintf('%d WhatsApp chats, %d messages', $waChats, $waMessages));

foreach (['conversations', 'messages', 'conversation_events', 'conversation_agent_alerts', 'visitors', 'visitor_sessions', 'wa_chats', 'wa_messages'] as $table) {
    DB::statement('ANALYZE TABLE '.$table);
}

$say('done');
