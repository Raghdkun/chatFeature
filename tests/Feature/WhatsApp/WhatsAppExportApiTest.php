<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `GET /whatsapp/export`: streamed CSV / JSON of messages or chats, filtered like the inbox, formula-injection safe, audited, administrators only.
 */
class WhatsAppExportApiTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    private WhatsAppSession $session;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = $this->whatsAppPeople()['admin'];
        $this->session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
    }

    private function export(string $query = ''): TestResponse
    {
        return $this->actingAs($this->admin, 'sanctum')->get('/api/v1/whatsapp/export'.$query);
    }

    /**
     * @return list<list<string|null>>
     */
    private function csvRows(TestResponse $response): array
    {
        $lines = array_filter(explode("\n", trim($response->streamedContent())), fn (string $line): bool => $line !== '');

        return array_map(fn (string $line): array => str_getcsv($line, ',', '"', ''), array_values($lines));
    }

    public function test_the_messages_of_every_chat_come_out_as_csv_with_the_documented_columns(): void
    {
        $widget = Widget::factory()->create(['name' => 'Main site']);
        $category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id]);
        $chat = WaChat::factory()->for($this->session, 'session')->linked($widget, $visitor, $category)->create(['phone_e164' => '+4915123456789', 'push_name' => 'Anna']);
        WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => 'Where is my refund?', 'wa_timestamp' => '2026-05-01 10:00:00']);
        WaMessage::factory()->for($chat, 'chat')->outbound($this->admin)->create(['body' => 'On it', 'wa_timestamp' => '2026-05-01 10:05:00']);

        $response = $this->export()->assertOk();

        $response->assertHeader('Content-Type', 'text/csv; charset=utf-8')->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->assertStringContainsString('attachment; filename="whatsapp-messages-', (string) $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $rows = $this->csvRows($response);
        $this->assertSame(['message', 'chat', 'session', 'phone', 'push_name', 'widget', 'category', 'direction', 'type', 'status', 'sent_by', 'timestamp', 'body', 'media_filename', 'media_mime', 'media_size'], $rows[0]);
        $this->assertCount(3, $rows);
        // A cell that starts with `+` is quoted like every other possible formula: the number keeps its text, a spreadsheet will not run it.
        $this->assertSame(['support-main', "'+4915123456789", 'Anna', 'Main site', 'Billing', 'in', 'text', 'received'], array_slice($rows[1], 2, 8));
        $this->assertSame('2026-05-01T10:00:00.000Z', $rows[1][11]);
        $this->assertSame('Where is my refund?', $rows[1][12]);
        $this->assertSame('out', $rows[2][7]);
        $this->assertSame($this->admin->label, $rows[2][10]);
        $this->assertStringNotContainsString('false_', $response->streamedContent(), 'no WhatsApp message ids');
    }

    public function test_spreadsheet_formulas_are_neutralised(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create(['push_name' => '=HYPERLINK("http://evil.test","x")']);
        foreach (['=1+1', '+49 151', '-2+3', '@SUM(A1)', "\tcmd", "\rcmd"] as $text) {
            WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => $text]);
        }

        $content = $this->export()->assertOk()->streamedContent();

        foreach (["'=1+1", "'+49 151", "'-2+3", "'@SUM(A1)", "'=HYPERLINK"] as $safe) {
            $this->assertStringContainsString($safe, $content);
        }

        $this->assertStringNotContainsString(',=1+1', $content);
        $this->assertStringNotContainsString('"=HYPERLINK', $content);
    }

    public function test_json_and_the_chats_resource(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create(['phone_e164' => '+4915123456789', 'unread_by_admin' => 2]);
        WaMessage::factory()->count(3)->for($chat, 'chat')->inbound()->create();

        $messages = $this->export('?format=json')->assertOk()->assertHeader('Content-Type', 'application/json; charset=utf-8');
        $this->assertCount(3, json_decode($messages->streamedContent(), true)['data']);

        $chats = json_decode($this->export('?format=json&resource=chats')->streamedContent(), true)['data'];
        $this->assertCount(1, $chats);
        $this->assertSame(3, $chats[0]['messages']);
        $this->assertSame(2, $chats[0]['unread']);
        $this->assertSame('+4915123456789', $chats[0]['phone'], 'JSON needs no quoting');

        $csv = $this->csvRows($this->export('?resource=chats'));
        $this->assertSame('chat', $csv[0][0]);
        $this->assertCount(2, $csv);
    }

    public function test_filters_and_the_message_time_range_narrow_the_export(): void
    {
        $open = WaChat::factory()->for($this->session, 'session')->create();
        $archived = WaChat::factory()->for($this->session, 'session')->archived()->create();
        WaMessage::factory()->for($open, 'chat')->inbound()->create(['body' => 'January text', 'wa_timestamp' => '2026-01-15 10:00:00']);
        WaMessage::factory()->for($open, 'chat')->inbound()->create(['body' => 'March text', 'wa_timestamp' => '2026-03-31 23:30:00']);
        WaMessage::factory()->for($archived, 'chat')->inbound()->create(['body' => 'Archived text', 'wa_timestamp' => '2026-03-01 10:00:00']);

        $bodies = fn (string $query): array => array_column(array_slice($this->csvRows($this->export($query)), 1), 12);

        $this->assertEqualsCanonicalizing(['January text', 'March text', 'Archived text'], $bodies(''), 'the export defaults to every status');
        $this->assertSame(['Archived text'], $bodies('?status=archived'));
        $this->assertEqualsCanonicalizing(['January text', 'March text'], $bodies('?status=open'));
        $this->assertSame(['March text'], $bodies('?status=open&from=2026-03-01'));
        $this->assertSame(['March text'], $bodies('?status=open&from=2026-03-31&to=2026-03-31'), 'a bare date covers the whole day');
        $this->assertSame(['January text'], $bodies('?status=open&to=2026-02-01'));
        $this->assertEqualsCanonicalizing(['January text', 'March text'], $bodies('?q=March'), 'a chat filter exports every message of the chats it matches');
        $this->assertSame([], $bodies('?session='.WhatsAppSession::factory()->create()->ulid));
    }

    public function test_every_export_is_audited_without_the_content(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create();
        WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => 'secret customer text']);

        $this->export('?format=json&resource=chats&status=open&q=secret')->assertOk()->streamedContent();

        $audit = AuditLog::query()->where('action', 'whatsapp.exported')->sole();
        $this->assertSame($this->admin->id, $audit->actor_id);
        $this->assertSame('json', $audit->changes['format']);
        $this->assertSame('chats', $audit->changes['resource']);
        // (MySQL's JSON type reorders keys: compare without the order.)
        $this->assertEquals(['status' => 'open', 'q' => 'secret'], $audit->changes['filters']);
        $this->assertStringNotContainsString('secret customer text', json_encode($audit->changes));
    }

    public function test_bad_parameters_are_422s(): void
    {
        foreach (['?format=xml', '?resource=sessions', '?status=gone', '?from=nonsense', '?session=x'] as $query) {
            $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/whatsapp/export'.$query)->assertStatus(422);
        }
    }

    public function test_a_large_export_streams_in_chunks(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create(['status' => WaChatStatus::Open]);
        WaMessage::factory()->count(1200)->for($chat, 'chat')->inbound()->create();

        $rows = $this->csvRows($this->export()->assertOk());

        $this->assertCount(1201, $rows);
    }
}
