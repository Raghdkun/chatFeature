<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Enums\OfferResponse;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * Real parallelism on MySQL: several PHP processes (tests/Support/race-worker.php) hit one database at the same instant.
 * SQLite cannot show a race, so this is opt-in and skipped by default:
 *
 *   CHAT_RACE_TEST=1 DB_CONNECTION=mysql DB_DATABASE=<a dedicated database> php artisan test tests/Feature/Chat/ConcurrencyMySqlTest.php
 *
 * It commits real rows (no RefreshDatabase: the workers must see them) and deletes what it created afterwards; it refuses to run
 * against the development database or the shared test database.
 */
class ConcurrencyMySqlTest extends TestCase
{
    use ChatFixtures;

    private const WORKERS = 12;

    /** @var list<int> */
    private array $widgetIds = [];

    /** @var list<int> */
    private array $userIds = [];

    /** @var list<int> */
    private array $categoryIds = [];

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
        if ($this->widgetIds !== []) {
            // Cascades to visitors, sessions, conversations, messages, offers, events, attachments.
            Widget::withTrashed()->whereIn('id', $this->widgetIds)->forceDelete();
            User::query()->whereIn('id', $this->userIds)->delete();
            Category::withTrashed()->whereIn('id', $this->categoryIds)->forceDelete();
        }

        parent::tearDown();
    }

    /**
     * @return array{0: Widget, 1: Category}
     */
    private function world(): array
    {
        $slug = 'race-'.Str::lower(Str::random(8));
        [$widget, $category] = $this->chatWidget(slug: $slug);
        $this->widgetIds[] = $widget->id;
        $this->categoryIds[] = $category->id;

        return [$widget, $category];
    }

    private function agent(Category $category, int $maxChats = 5): User
    {
        $agent = $this->availableAgent($category, ['max_concurrent_chats' => $maxChats]);
        $this->userIds[] = $agent->id;

        return $agent;
    }

    /**
     * Start one worker per argument list at a shared instant and collect what each printed.
     *
     * @param  list<list<string>>  $jobs  worker arguments after the action
     * @return list<array<string, mixed>>
     */
    private function runWorkers(string $action, array $jobs): array
    {
        $startAt = microtime(true) + 4.0;
        $environment = array_merge(getenv(), [
            'APP_ENV' => 'testing',
            'DB_CONNECTION' => (string) config('database.default'),
            'DB_DATABASE' => (string) DB::connection()->getDatabaseName(),
            'DB_HOST' => (string) config('database.connections.'.config('database.default').'.host'),
            'DB_PORT' => (string) config('database.connections.'.config('database.default').'.port'),
            'DB_USERNAME' => (string) config('database.connections.'.config('database.default').'.username'),
            'DB_PASSWORD' => (string) config('database.connections.'.config('database.default').'.password'),
            'BROADCAST_CONNECTION' => 'null',
            'QUEUE_CONNECTION' => 'sync',
            'CACHE_STORE' => 'array',
            'MAIL_MAILER' => 'array',
        ]);

        $processes = [];

        foreach ($jobs as $arguments) {
            $command = [PHP_BINARY, base_path('tests/Support/race-worker.php'), $action, sprintf('%.6F', $startAt), ...$arguments];
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

    public function test_parallel_claims_of_one_chat_have_exactly_one_winner(): void
    {
        [$widget, $category] = $this->world();
        $agents = array_map(fn (): User => $this->agent($category), range(1, self::WORKERS));
        $chat = $this->queuedChat($this->visitorSession($widget), $category, $agents);

        $results = $this->runWorkers('claim', array_map(fn (User $agent): array => [$chat->ulid, (string) $agent->id], $agents));

        $winners = array_values(array_filter($results, fn (array $result): bool => ($result['ok'] ?? false) === true));
        $losers = array_values(array_filter($results, fn (array $result): bool => ($result['error'] ?? null) === 'already_claimed'));
        $this->assertCount(1, $winners, 'exactly one claim wins: '.json_encode($results));
        $this->assertCount(self::WORKERS - 1, $losers, 'everyone else is told it was taken: '.json_encode($results));

        $chat->refresh();
        $this->assertSame('active', $chat->status->value);
        $this->assertContains($chat->assigned_agent_id, array_map(fn (User $agent): int => $agent->id, $agents));
        $this->assertSame(1, $chat->claim_version, 'the atomic update ran once');
        $this->assertSame(1, $chat->events()->where('type', 'claimed')->count());

        // One accepted offer (the winner's), the rest taken; one "joined" line.
        $offers = ConversationOffer::query()->where('conversation_id', $chat->id)->get();
        $this->assertSame(1, $offers->where('response', OfferResponse::Accepted)->count());
        $this->assertSame($chat->assigned_agent_id, $offers->firstWhere('response', OfferResponse::Accepted)->user_id);
        $this->assertSame(self::WORKERS - 1, $offers->where('response', OfferResponse::Taken)->count());
        $this->assertSame(0, $offers->whereNull('response')->count());
        $this->assertSame(1, Message::query()->where('conversation_id', $chat->id)->count());
        $this->assertSame(1, $chat->last_seq);
    }

    public function test_one_agents_parallel_claims_never_exceed_their_capacity(): void
    {
        [$widget, $category] = $this->world();
        $agent = $this->agent($category, maxChats: 2);
        $chats = array_map(fn () => $this->queuedChat($this->visitorSession($widget), $category, [$agent]), range(1, 8));

        $results = $this->runWorkers('claim', array_map(fn (Conversation $chat): array => [$chat->ulid, (string) $agent->id], $chats));

        $this->assertCount(2, array_filter($results, fn (array $result): bool => ($result['ok'] ?? false) === true), 'capacity is 2: '.json_encode($results));
        $this->assertCount(6, array_filter($results, fn (array $result): bool => ($result['error'] ?? null) === 'at_capacity'), json_encode($results));
        $this->assertSame(2, Conversation::query()->where('assigned_agent_id', $agent->id)->where('status', 'active')->count());
    }

    public function test_parallel_messages_get_unique_gapless_numbers_and_replays_are_idempotent(): void
    {
        [$widget, $category] = $this->world();
        $agent = $this->agent($category);
        $chat = $this->activeChat($this->visitorSession($widget), $category, $agent);
        $perWorker = 5;
        $shared = (string) Str::ulid();

        $jobs = [];
        foreach (range(1, 8) as $i) {
            $jobs[] = [$chat->ulid, '0', (string) $perWorker, '-', "visitor-{$i}"];
        }
        foreach (range(1, 4) as $i) {
            $jobs[] = [$chat->ulid, (string) $agent->id, (string) $perWorker, '-', "agent-{$i}"];
        }
        // Four workers retry ONE message with the same client_msg_id at the same moment: it must exist once.
        foreach (range(1, 4) as $i) {
            $jobs[] = [$chat->ulid, '0', '1', $shared, 'retry'];
        }

        $results = $this->runWorkers('send', $jobs);

        foreach ($results as $result) {
            $this->assertTrue($result['ok'] ?? false, 'a worker failed: '.json_encode($result));
        }
        $this->assertSame(8 * $perWorker + 4 * $perWorker + 1, array_sum(array_column($results, 'created')));
        $this->assertSame(3, array_sum(array_column($results, 'replayed')), 'three of the four retries were replays');

        $total = 8 * $perWorker + 4 * $perWorker + 1;
        $seqs = Message::query()->where('conversation_id', $chat->id)->orderBy('seq')->pluck('seq')->map(fn ($seq): int => (int) $seq)->all();
        $this->assertSame(range(1, $total), $seqs, 'every number once, no gaps');

        $chat->refresh();
        $this->assertSame($total, $chat->last_seq);
        $this->assertSame(8 * $perWorker + 1, $chat->unseen_by_agent, 'visitor messages incl. the single retried one');
        $this->assertSame(4 * $perWorker, $chat->unseen_by_visitor);
        $this->assertSame(1, Message::query()->where('conversation_id', $chat->id)->where('client_msg_id', $shared)->count());
    }

    public function test_the_full_text_index_finds_committed_messages(): void
    {
        [$widget, $category] = $this->world();
        $agent = $this->agent($category);
        $match = $this->activeChat($this->visitorSession($widget), $category, $agent);
        $other = $this->activeChat($this->visitorSession($widget), $category, $agent);
        Message::factory()->for($match)->create(['body' => 'I would like a refund for my invoice']);
        Message::factory()->for($other)->create(['body' => 'How do I reset my password?']);
        $get = fn (string $q): array => array_column($this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations?q='.urlencode($q))->assertOk()->json('data'), 'ulid');

        $this->assertSame([$match->ulid], $get('refund'));
        $this->assertSame([$match->ulid], $get('refu'), 'every word is a prefix');
        $this->assertSame([$match->ulid], $get('invoice refund'), 'all words must match');
        $this->assertSame([], $get('refund banana'));
        $this->assertSame([$other->ulid], $get('+password* ("reset")'), 'boolean operators typed by the user are plain text, not syntax');
        $this->assertSame([], $get('password -refund'), 'a minus does not exclude: both words are required');
        $this->assertSame([], $get('banana'));
    }
}
