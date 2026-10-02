<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * Real parallelism on MySQL: several PHP processes (tests/Support/wa-race-worker.php) hit one database at the same instant. SQLite cannot show
 * a race, so this is opt-in and skipped by default:
 *
 *   CHAT_RACE_TEST=1 DB_CONNECTION=mysql DB_DATABASE=<a dedicated database> php artisan test tests/Feature/WhatsApp/ConcurrencyMySqlTest.php
 *
 * It commits real rows (no RefreshDatabase: the workers must see them) and deletes what it created afterwards; it refuses to run against the
 * development database or the shared test database.
 */
class ConcurrencyMySqlTest extends TestCase
{
    use OpenWaWebhooks;

    private const WORKERS = 10;

    /** @var list<int> */
    private array $sessionIds = [];

    /** @var list<int> */
    private array $widgetIds = [];

    /** @var list<int> */
    private array $userIds = [];

    protected function setUp(): void
    {
        parent::setUp();

        if (getenv('CHAT_RACE_TEST') !== '1') {
            $this->markTestSkipped('Set CHAT_RACE_TEST=1 (and DB_CONNECTION=mysql, DB_DATABASE=<dedicated database>) to run the MySQL concurrency tests.');
        }

        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->markTestSkipped('The concurrency tests need MySQL / MariaDB.');
        }

        if (in_array(DB::connection()->getDatabaseName(), ['chatfeature', 'chatfeature_testing', ''], true)) {
            $this->markTestSkipped('Refusing to commit test rows into the development database; point DB_DATABASE at a dedicated one.');
        }
    }

    protected function tearDown(): void
    {
        if ($this->sessionIds !== [] || $this->widgetIds !== [] || $this->userIds !== []) {
            // Cascades to chats, messages, tickets, deliveries and the send counters.
            WhatsAppSession::withTrashed()->whereIn('id', $this->sessionIds)->forceDelete();
            Widget::withTrashed()->whereIn('id', $this->widgetIds)->forceDelete();
            User::query()->whereIn('id', $this->userIds)->delete();
        }

        parent::tearDown();
    }

    private function newSession(): WhatsAppSession
    {
        $session = WhatsAppSession::factory()->ready()->withWebhook('a-webhook-secret-of-forty-characters-0001')->create(['name' => 'race-'.Str::lower(Str::random(8))]);
        $this->sessionIds[] = $session->id;

        return $session;
    }

    /**
     * @param  list<list<string>>  $jobs  worker arguments after the action
     * @return list<array<string, mixed>>
     */
    private function runWorkers(string $action, array $jobs): array
    {
        $startAt = microtime(true) + 4.0;
        $connection = (string) config('database.default');
        $environment = array_merge(getenv(), [
            'APP_ENV' => 'testing',
            'DB_CONNECTION' => $connection,
            'DB_DATABASE' => (string) DB::connection()->getDatabaseName(),
            'DB_HOST' => (string) config("database.connections.{$connection}.host"),
            'DB_PORT' => (string) config("database.connections.{$connection}.port"),
            'DB_USERNAME' => (string) config("database.connections.{$connection}.username"),
            'DB_PASSWORD' => (string) config("database.connections.{$connection}.password"),
            'BROADCAST_CONNECTION' => 'null',
            'QUEUE_CONNECTION' => 'sync',
            'CACHE_STORE' => 'array',
            'MAIL_MAILER' => 'array',
        ]);

        $processes = [];

        foreach ($jobs as $arguments) {
            $command = [PHP_BINARY, base_path('tests/Support/wa-race-worker.php'), $action, sprintf('%.6F', $startAt), ...$arguments];
            $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, base_path(), $environment);
            $this->assertIsResource($process, 'could not start a worker');
            $processes[] = [$process, $pipes];
        }

        $results = [];

        foreach ($processes as [$process, $pipes]) {
            $out = trim((string) stream_get_contents($pipes[1]));
            $err = trim((string) stream_get_contents($pipes[2]));
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);

            $decoded = json_decode($out, true);
            $this->assertIsArray($decoded, "worker printed no JSON. stdout: {$out} stderr: {$err}");
            $results[] = $decoded;
        }

        return $results;
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function encoded(WhatsAppSession $session, array $body): string
    {
        return base64_encode($this->rawBody($session, $body));
    }

    /**
     * @param  list<array<string, mixed>>  $results
     */
    private function tally(array $results, string $key, mixed $value): int
    {
        return count(array_filter($results, fn (array $result): bool => ($result[$key] ?? null) === $value));
    }

    public function test_the_same_delivery_arriving_in_parallel_is_stored_and_processed_once(): void
    {
        $session = $this->newSession();
        $body = $this->encoded($session, $this->messageReceived(['id' => 'false_4915123456789@c.us_RACE1'], key: 'msg_race_1'));

        $results = $this->runWorkers('deliver', array_fill(0, self::WORKERS, [$session->ulid, $body, 'msg_race_1']));

        $this->assertSame(1, $this->tally($results, 'status', 'accepted'), json_encode($results));
        $this->assertSame(self::WORKERS - 1, $this->tally($results, 'status', 'duplicate'), json_encode($results));
        $this->assertSame(1, WaWebhookDelivery::query()->where('session_id', $session->id)->count());
        $this->assertSame(1, WaMessage::query()->whereIn('wa_chat_id', WaChat::query()->where('session_id', $session->id)->select('id'))->count());
        $this->assertSame(1, WaChat::query()->where('session_id', $session->id)->sole()->unread_by_admin);
    }

    public function test_one_message_delivered_under_different_keys_is_stored_once(): void
    {
        // A re-registered webhook changes every key: the unique `(chat, message id)` index is the safety net.
        $session = $this->newSession();
        $jobs = [];

        foreach (range(1, self::WORKERS) as $index) {
            $body = $this->messageReceived(['id' => 'false_4915123456789@c.us_RACE2'], key: 'msg_race_2_webhook_'.$index);
            $jobs[] = [$session->ulid, $this->encoded($session, $body), 'msg_race_2_webhook_'.$index];
        }

        $results = $this->runWorkers('deliver', $jobs);

        $this->assertSame(self::WORKERS, $this->tally($results, 'status', 'accepted'), json_encode($results));
        $this->assertSame(1, WaMessage::query()->whereIn('wa_chat_id', WaChat::query()->where('session_id', $session->id)->select('id'))->count());
        $chat = WaChat::query()->where('session_id', $session->id)->sole();
        $this->assertSame(1, $chat->unread_by_admin, 'counted once');
        $this->assertSame(1, WaWebhookDelivery::query()->where('session_id', $session->id)->where('outcome', 'processed')->count());
        $this->assertSame(self::WORKERS - 1, WaWebhookDelivery::query()->where('session_id', $session->id)->where('outcome', 'duplicate')->count());
        $this->assertSame(0, WaWebhookDelivery::query()->where('session_id', $session->id)->whereNull('outcome')->count(), 'nothing left waiting');
    }

    public function test_many_new_messages_of_one_new_customer_make_one_chat_and_an_exact_unread_count(): void
    {
        $session = $this->newSession();
        $jobs = [];

        foreach (range(1, self::WORKERS) as $index) {
            $body = $this->messageReceived(['id' => 'false_4915123456789@c.us_NEW'.$index, 'body' => 'message '.$index, 'timestamp' => now()->getTimestamp() + $index], key: 'msg_new_'.$index);
            $jobs[] = [$session->ulid, $this->encoded($session, $body), 'msg_new_'.$index];
        }

        $results = $this->runWorkers('deliver', $jobs);

        $this->assertSame(self::WORKERS, $this->tally($results, 'status', 'accepted'), json_encode($results));
        $this->assertSame(1, WaChat::query()->where('session_id', $session->id)->count(), 'one chat for one customer');
        $chat = WaChat::query()->where('session_id', $session->id)->sole();
        $this->assertSame(self::WORKERS, WaMessage::query()->where('wa_chat_id', $chat->id)->count());
        $this->assertSame(self::WORKERS, $chat->unread_by_admin, 'every message counted exactly once');
        $this->assertSame('message '.self::WORKERS, $chat->last_message_preview, 'the preview is the newest, whatever the order');
        $this->assertSame(0, WaWebhookDelivery::query()->where('session_id', $session->id)->whereNotIn('outcome', ['processed'])->count());
    }

    public function test_one_code_said_by_many_customers_at_once_links_exactly_one_chat(): void
    {
        $session = $this->newSession();
        $widget = Widget::factory()->create();
        $this->widgetIds[] = $widget->id;
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id]);
        $ticket = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'visitor_id' => $visitor->id, 'session_id' => $session->id, 'code' => 'K7M2QX4P', 'expires_at' => now()->addHour()]);
        $jobs = [];

        foreach (range(1, self::WORKERS) as $index) {
            $chatId = '49151000000'.str_pad((string) $index, 2, '0', STR_PAD_LEFT).'@c.us';
            $body = $this->messageReceived(['id' => 'false_'.$chatId.'_LINK'.$index, 'from' => $chatId, 'chatId' => $chatId, 'body' => 'my code is K7M2QX4P'], key: 'msg_link_'.$index);
            $jobs[] = [$session->ulid, $this->encoded($session, $body), 'msg_link_'.$index];
        }

        $results = $this->runWorkers('deliver', $jobs);

        $this->assertSame(self::WORKERS, $this->tally($results, 'status', 'accepted'), json_encode($results));
        $this->assertSame(self::WORKERS, WaChat::query()->where('session_id', $session->id)->count());
        $linked = WaChat::query()->where('session_id', $session->id)->whereNotNull('handoff_ticket_id')->get();
        $this->assertCount(1, $linked, 'one ticket links one chat');
        $this->assertSame($ticket->id, $linked->first()->handoff_ticket_id);
        $this->assertSame($widget->id, $linked->first()->widget_id);
        $ticket->refresh();
        $this->assertNotNull($ticket->consumed_at);
        $this->assertSame($linked->first()->id, $ticket->wa_chat_id);
    }

    public function test_parallel_replies_never_exceed_the_daily_cap(): void
    {
        $session = $this->newSession();
        $session->forceFill(['settings' => ['daily_send_cap' => 12, 'send_min_interval_ms' => 0]])->save();
        $chat = WaChat::factory()->for($session, 'session')->create(['inbound_initiated' => true]);
        $admin = User::factory()->admin()->create();
        $this->userIds[] = $admin->id;

        // Ten workers, five replies each: 50 attempts against a cap of 12.
        $results = $this->runWorkers('reply', array_fill(0, self::WORKERS, [$chat->ulid, (string) $admin->id, '5', '-']));

        $created = array_sum(array_column($results, 'created'));
        $capped = array_sum(array_column($results, 'capped'));
        $this->assertSame(12, $created, 'exactly the cap: '.json_encode($results));
        $this->assertSame(38, $capped);
        $this->assertSame(12, WaMessage::query()->where('wa_chat_id', $chat->id)->count());
        $this->assertSame(12, app(SendCounter::class)->used($session), 'the counter agrees with the rows');
    }

    public function test_parallel_requests_with_one_client_msg_id_create_one_message_and_use_one_slot(): void
    {
        $session = $this->newSession();
        $session->forceFill(['settings' => ['daily_send_cap' => 50, 'send_min_interval_ms' => 0]])->save();
        $chat = WaChat::factory()->for($session, 'session')->create(['inbound_initiated' => true]);
        $admin = User::factory()->admin()->create();
        $this->userIds[] = $admin->id;
        $clientMsgId = strtolower((string) Str::ulid());

        $results = $this->runWorkers('reply', array_fill(0, self::WORKERS, [$chat->ulid, (string) $admin->id, '1', $clientMsgId]));

        $this->assertSame(1, array_sum(array_column($results, 'created')), json_encode($results));
        $this->assertSame(self::WORKERS - 1, array_sum(array_column($results, 'replayed')));
        $this->assertSame(1, WaMessage::query()->where('wa_chat_id', $chat->id)->count());
        $this->assertSame(1, app(SendCounter::class)->used($session), 'a repeat takes no slot');
        $this->assertSame(WaMessageStatus::Pending, WaMessage::query()->where('wa_chat_id', $chat->id)->sole()->status);
    }

    public function test_the_counter_itself_is_atomic(): void
    {
        $session = $this->newSession();
        $session->forceFill(['settings' => ['daily_send_cap' => 7]])->save();
        $counter = app(SendCounter::class);
        $taken = 0;

        foreach (range(1, 20) as $ignored) {
            $taken += $counter->reserve($session->refresh()) ? 1 : 0;
        }

        $this->assertSame(7, $taken);
        $counter->release($session->id, now());
        $this->assertTrue($counter->reserve($session));
        $this->assertFalse($counter->reserve($session));
    }
}
