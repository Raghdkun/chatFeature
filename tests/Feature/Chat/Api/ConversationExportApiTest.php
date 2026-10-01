<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Services\ConversationExporter;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `GET /conversations/export`: admin only, CSV or JSON, streamed in chunks, with the list's filters.
 */
class ConversationExportApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $admin;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->admin = User::factory()->admin()->create();
        $this->agent = User::factory()->agent()->create(['name' => 'Agent Smith']);
        $this->billing->users()->attach($this->agent->id);
    }

    /**
     * @return list<list<string|null>>
     */
    private function csvRows(string $csv): array
    {
        $rows = [];
        $stream = fopen('php://memory', 'w+b');
        fwrite($stream, $csv);
        rewind($stream);

        while (($row = fgetcsv($stream, null, ',', '"', '')) !== false) {
            $rows[] = $row;
        }

        return $rows;
    }

    public function test_only_an_admin_may_export(): void
    {
        $this->getJson('/api/v1/conversations/export')->assertUnauthorized();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations/export')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->actingAs(User::factory()->admin()->inactive()->create(), 'sanctum')->getJson('/api/v1/conversations/export')->assertStatus(401);
    }

    public function test_the_csv_has_one_row_per_conversation_and_neutralises_spreadsheet_formulas(): void
    {
        $visitor = Visitor::factory()->create(['widget_id' => $this->widget->id, 'name' => '=HYPERLINK("http://evil.test","x")', 'email' => 'a,b"c@example.test']);
        $closed = Conversation::factory()->closed($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id, 'visitor_id' => $visitor->id]);
        Message::factory()->count(3)->for($closed)->create();
        Rating::factory()->create(['conversation_id' => $closed->id, 'score' => 5]);
        $queued = Conversation::factory()->create(['widget_id' => $this->widget->id]);

        $response = $this->actingAs($this->admin, 'sanctum')->get('/api/v1/conversations/export?format=csv');

        $response->assertOk();
        $this->assertInstanceOf(StreamedResponse::class, $response->baseResponse);
        $this->assertStringStartsWith('text/csv', $response->headers->get('Content-Type'));
        $this->assertMatchesRegularExpression('/^attachment; filename="?conversations-\d{8}-\d{6}\.csv"?$/', $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));

        $rows = $this->csvRows($response->streamedContent());
        $this->assertSame(ConversationExporter::COLUMNS, $rows[0]);
        $this->assertCount(3, $rows);

        $byTicket = [];
        foreach (array_slice($rows, 1) as $row) {
            $byTicket[$row[0]] = array_combine(ConversationExporter::COLUMNS, $row);
        }

        $exported = $byTicket[$closed->ticket_no];
        $this->assertSame($closed->ulid, $exported['conversation']);
        $this->assertSame('closed', $exported['status']);
        $this->assertSame('live', $exported['type']);
        $this->assertSame('Billing', $exported['category']);
        $this->assertSame('Agent Smith', $exported['agent']);
        $this->assertSame("'=HYPERLINK(\"http://evil.test\",\"x\")", $exported['visitor_name'], 'a leading = is defused');
        $this->assertSame('a,b"c@example.test', $exported['visitor_email'], 'commas and quotes survive');
        $this->assertSame('3', $exported['messages']);
        $this->assertSame('5', $exported['rating']);
        $this->assertSame('false', $exported['visitor_verified']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $exported['created_at']);
        $this->assertSame('', $byTicket[$queued->ticket_no]['agent']);
        $this->assertSame('0', $byTicket[$queued->ticket_no]['messages']);

        $this->assertDatabaseHas('audit_logs', ['action' => 'conversations.exported', 'actor_id' => $this->admin->id]);
    }

    public function test_the_json_export_is_one_valid_document(): void
    {
        $chats = Conversation::factory()->count(3)->create(['widget_id' => $this->widget->id]);

        $response = $this->actingAs($this->admin, 'sanctum')->get('/api/v1/conversations/export?format=json');

        $response->assertOk();
        $this->assertStringStartsWith('application/json', $response->headers->get('Content-Type'));
        $this->assertStringContainsString('conversations-', $response->headers->get('Content-Disposition'));
        $document = json_decode($response->streamedContent(), true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(3, $document['data']);
        $this->assertEqualsCanonicalizing($chats->pluck('ulid')->all(), array_column($document['data'], 'conversation'));
        $this->assertSame(ConversationExporter::COLUMNS, array_keys($document['data'][0]));
        $this->assertTrue($document['data'][0]['visitor_verified'] === false);
        $this->assertIsInt($document['data'][0]['messages']);

        // An empty range is still a valid document.
        $empty = $this->actingAs($this->admin, 'sanctum')->get('/api/v1/conversations/export?format=json&status=missed');
        $this->assertSame(['data' => []], json_decode($empty->streamedContent(), true, flags: JSON_THROW_ON_ERROR));
    }

    public function test_the_export_takes_the_list_filters(): void
    {
        $match = Conversation::factory()->closed($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $other = Conversation::factory()->create(['widget_id' => $this->widget->id]);
        Message::factory()->for($match)->create(['body' => 'need a refund']);

        $tickets = fn (string $query): array => array_column(array_slice($this->csvRows($this->actingAs($this->admin, 'sanctum')->get('/api/v1/conversations/export?'.$query)->streamedContent()), 1), 0);

        $this->assertSame([$match->ticket_no], $tickets('status=closed'));
        $this->assertSame([$other->ticket_no], $tickets('status=queued'));
        $this->assertSame([$match->ticket_no], $tickets('q='.$match->ticket_no));
        $this->assertSame([$match->ticket_no], $tickets('category=billing'));
        $this->assertSame([$match->ticket_no], $tickets('agent='.$this->agent->id));
        $this->assertCount(2, $tickets(''));
        $this->assertSame([], $tickets('from='.urlencode(Carbon::now()->addDay()->toIso8601String())));

        $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations/export?format=xml')->assertStatus(422);
        $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations/export?status=nope')->assertStatus(422);
    }

    public function test_a_large_range_is_streamed_in_chunks_without_a_query_per_row(): void
    {
        $visitor = Visitor::factory()->create(['widget_id' => $this->widget->id]);
        $total = ConversationExporter::CHUNK * 2 + 10;
        $now = now()->toDateTimeString();

        foreach (array_chunk(range(1, $total), 250) as $batch) {
            Conversation::query()->insert(array_map(fn (int $i): array => [
                'ulid' => (string) Str::ulid(),
                'widget_id' => $this->widget->id,
                'visitor_id' => $visitor->id,
                'ticket_no' => sprintf('T%05d', $i),
                'type' => 'live',
                'status' => 'closed',
                'created_at' => $now,
                'updated_at' => $now,
            ], $batch));
        }

        DB::enableQueryLog();
        $csv = $this->actingAs($this->admin, 'sanctum')->get('/api/v1/conversations/export')->streamedContent();
        $queries = count(DB::getQueryLog());
        DB::disableQueryLog();

        $rows = $this->csvRows($csv);
        $this->assertCount($total + 1, $rows);
        $this->assertCount($total, array_unique(array_column(array_slice($rows, 1), 0)), 'every conversation exactly once');
        $this->assertLessThan(60, $queries, 'chunked reads and eager loads, not a query per row');
    }
}
