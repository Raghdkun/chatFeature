<?php

namespace Tests\Feature\Privacy;

use App\Models\AuditLog;
use App\Models\Conversation;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\PrivacyWorld;
use Tests\TestCase;

/** `GET /api/v1/visitors/{ulid}/export`: everything held about one visitor, nothing about anyone else, administrators only, audited. */
class VisitorExportTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, PrivacyWorld, RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useRealtime();
        Storage::fake('local');
        $this->admin = User::factory()->admin()->create();
    }

    private function export(string $ulid, ?User $as = null): TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->actingAs($as ?? $this->admin, 'sanctum')->get('/api/v1/visitors/'.$ulid.'/export', ['Accept' => 'application/json']);
    }

    public function test_the_export_holds_everything_about_the_visitor_and_nothing_about_anybody_else(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category, ['name' => 'Jane Doe', 'email' => 'jane@example.test', 'phone' => '+49 30 111', 'external_id' => 'cust-1', 'verified' => true, 'meta' => ['plan' => 'pro']]);
        $john = $this->visitorWithHistory($widget, $category, ['name' => 'John Roe', 'email' => 'john@example.test']);
        WaChat::factory()->create(['visitor_id' => $jane['visitor']->id, 'widget_id' => $widget->id]);
        WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'visitor_id' => $jane['visitor']->id]);

        $response = $this->export($jane['visitor']->ulid)->assertOk();
        $body = $response->streamedContent();
        $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);

        $response->assertHeader('Cache-Control', 'no-store, private');
        $this->assertStringContainsString('visitor-'.$jane['visitor']->ulid.'.json', (string) $response->headers->get('Content-Disposition'));
        $this->assertSame('application/json; charset=utf-8', $response->headers->get('Content-Type'));

        // The subject, as stored.
        $this->assertSame(['visitor', 'Jane Doe', 'jane@example.test', '+49 30 111', 'cust-1', true, ['plan' => 'pro']], [$data['subject']['type'], $data['subject']['name'], $data['subject']['email'], $data['subject']['phone'], $data['subject']['externalId'], $data['subject']['verified'], $data['subject']['meta']]);
        $this->assertCount(1, $data['sessions']);
        $this->assertArrayNotHasKey('tokenHash', $data['sessions'][0]);
        $this->assertArrayNotHasKey('networkHash', $data['sessions'][0]);

        // Every conversation, in order, with its messages, attachments (signed URL), rating and timeline.
        $this->assertCount(3, $data['conversations']);
        $first = $data['conversations'][0];
        $this->assertSame($jane['conversations'][0]->ulid, $first['ulid']);
        $this->assertSame([1, 2, 3], array_column($first['messages'], 'seq'));
        $this->assertSame(['visitor', 'agent', 'visitor'], array_column($first['messages'], 'sender'));
        $this->assertStringContainsString('private words '.$jane['visitor']->ulid, $first['messages'][0]['body']);
        $this->assertSame('Agent Smith', $first['messages'][1]['agent']);
        $this->assertCount(1, $first['messages'][0]['attachments']);
        $this->assertStringContainsString($first['messages'][0]['attachments'][0]['ulid'], $first['messages'][0]['attachments'][0]['url']);
        $this->assertSame(5, $first['rating']['score']);
        $this->assertNotEmpty($first['events']);
        $this->assertSame('offline', end($data['conversations'])['type']);

        // The WhatsApp records that point at them are counted, not copied.
        $this->assertSame(['linkedChats' => 1, 'handoffTickets' => 1], $data['whatsapp']);

        // Nobody else's data, no staff e-mail address, no hash.
        foreach (['John Roe', 'john@example.test', $john['visitor']->ulid, 'agent.smith@secret.example', 'token_hash', 'network_hash'] as $foreign) {
            $this->assertStringNotContainsString($foreign, $body);
        }
    }

    public function test_the_export_is_audited_with_counts_and_no_content(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category, ['name' => 'Jane Doe', 'email' => 'jane@example.test']);

        $this->export($jane['visitor']->ulid)->assertOk()->streamedContent();

        $entry = AuditLog::query()->where('action', 'privacy.visitor.exported')->sole();
        $this->assertSame($this->admin->id, $entry->actor_id);
        // MySQL JSON columns reorder object keys: compare the decoded arrays, not their order
        $this->assertEquals(['visitor' => $jane['visitor']->ulid, 'conversations' => 3, 'messages' => 7], $entry->changes);
    }

    public function test_an_unknown_visitor_is_a_404_and_only_administrators_may_export(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);

        $this->export('01HZZZZZZZZZZZZZZZZZZZZZZZ')->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->export('not-a-ulid')->assertNotFound();
        $this->export($jane['visitor']->ulid, User::factory()->agent()->create())->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/v1/visitors/'.$jane['visitor']->ulid.'/export')->assertUnauthorized();
        $this->assertSame(0, AuditLog::query()->where('action', 'privacy.visitor.exported')->count(), 'a refused request leaves no export record');
    }

    public function test_a_visitor_without_any_history_exports_an_empty_but_valid_document(): void
    {
        [$widget] = $this->chatWidget();
        $token = $this->visitorSession($widget, ['name' => 'Nobody']);

        $data = json_decode($this->export($token->session->visitor->ulid)->assertOk()->streamedContent(), true, 512, JSON_THROW_ON_ERROR);

        $this->assertSame([], $data['conversations']);
        $this->assertSame(0, Conversation::query()->count());
        $this->assertCount(1, $data['sessions']);
    }
}
