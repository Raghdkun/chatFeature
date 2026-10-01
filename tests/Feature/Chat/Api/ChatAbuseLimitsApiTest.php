<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * Anti-automation of the public chat API (the Origin gate is forgeable by a non-browser client): per widget + network and global
 * start budgets, the cooldown after a cancelled chat, the cap of chats queued from one network, the same budgets for offline tickets,
 * the network limiter in front of the token lookup and the per-conversation attachment quota.
 */
class ChatAbuseLimitsApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->availableAgent($this->billing);
    }

    /** A real session opened through the API (it records the client network, unlike the fixtures). */
    private function openSession(?string $ip = null): IssuedVisitorToken
    {
        $response = $this->withoutToken()->withServerVariables(['REMOTE_ADDR' => $ip ?? '127.0.0.1'])
            ->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])
            ->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions')
            ->assertCreated();

        $token = (string) $response->json('data.visitorToken');

        return $this->tokenFor($token);
    }

    private function start(IssuedVisitorToken $token, ?string $ip = null): TestResponse
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $ip ?? '127.0.0.1'])
            ->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann']);
    }

    private function leave(IssuedVisitorToken $token, ?string $ip = null): TestResponse
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $ip ?? '127.0.0.1'])
            ->withToken($token->plaintext)->postJson('/api/v1/public/offline-tickets', ['name' => 'Ann', 'email' => 'ann@example.test', 'message' => 'Call me']);
    }

    private function tokenFor(string $plaintext): IssuedVisitorToken
    {
        return new IssuedVisitorToken($plaintext, app(VisitorTokenService::class)->find($plaintext));
    }

    public function test_starting_chats_is_budgeted_per_widget_and_network(): void
    {
        config(['chat.rate_limits.start_per_widget_network' => 2, 'chat.max_queued_per_network' => 100]);

        $this->start($this->visitorSession($this->widget))->assertCreated();
        $this->start($this->visitorSession($this->widget))->assertCreated();
        $this->start($this->visitorSession($this->widget))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');

        // Another network has its own budget, and so does another widget on the same network.
        $this->start($this->visitorSession($this->widget), '203.0.113.7')->assertCreated();

        [$other, $category] = $this->chatWidget(slug: 'sales');
        $this->availableAgent($category);
        $this->withToken($this->visitorSession($other)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'sales'])->assertCreated();
    }

    public function test_starting_chats_has_a_ceiling_per_widget_across_networks(): void
    {
        config(['chat.rate_limits.start_per_widget' => 2, 'chat.max_queued_per_network' => 100]);

        $this->start($this->visitorSession($this->widget), '203.0.113.1')->assertCreated();
        $this->start($this->visitorSession($this->widget), '203.0.113.2')->assertCreated();
        $this->start($this->visitorSession($this->widget), '203.0.113.3')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
    }

    public function test_a_visitor_cannot_start_another_chat_right_after_cancelling_one(): void
    {
        $token = $this->openSession();
        $chat = $this->start($token)->assertCreated()->json('data.ulid');

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat}/cancel")->assertOk()->assertJsonPath('data.status', 'closed');

        $response = $this->start($token)->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
        $this->assertLessThanOrEqual(10, (int) $response->headers->get('Retry-After'));
        $this->assertGreaterThanOrEqual(1, (int) $response->json('error.details.retry_after'));

        // A rotated token is still the same visitor.
        $rotated = $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$token->plaintext])
            ->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions')->assertCreated()->json('data.visitorToken');
        $this->start($this->tokenFor($rotated))->assertStatus(429);

        $this->travel(11)->seconds();

        $this->start($this->tokenFor($rotated))->assertCreated();
    }

    public function test_the_cooldown_follows_the_visitor_who_cancelled_not_everyone_on_the_network(): void
    {
        $first = $this->openSession();
        $second = $this->openSession();
        $chat = $this->start($first)->assertCreated()->json('data.ulid');
        $this->withToken($first->plaintext)->postJson("/api/v1/public/conversations/{$chat}/cancel")->assertOk();

        $this->start($second)->assertCreated();
    }

    public function test_only_a_few_chats_can_wait_from_one_network_on_one_widget(): void
    {
        config(['chat.max_queued_per_network' => 2]);

        $this->start($this->openSession())->assertCreated();
        $this->start($this->openSession())->assertCreated();
        $this->start($this->openSession())->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');

        // Another network is unaffected; once a chat is no longer waiting there is room again.
        $this->start($this->openSession('203.0.113.9'), '203.0.113.9')->assertCreated();
        Conversation::query()->orderBy('id')->first()->forceFill(['status' => ConversationStatus::Active])->save();
        $this->start($this->openSession())->assertCreated();
    }

    public function test_offline_tickets_have_the_same_budgets(): void
    {
        config(['chat.rate_limits.offline_per_widget_network' => 2, 'chat.rate_limits.offline_per_widget' => 3, 'chat.rate_limits.public_offline_ip' => 100]);

        $this->leave($this->visitorSession($this->widget))->assertCreated();
        $this->leave($this->visitorSession($this->widget))->assertCreated();
        $this->leave($this->visitorSession($this->widget))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');

        $this->leave($this->visitorSession($this->widget), '203.0.113.5')->assertCreated();
        $this->leave($this->visitorSession($this->widget), '203.0.113.6')->assertStatus(429);
    }

    public function test_random_bearer_tokens_are_throttled_before_the_token_is_looked_up(): void
    {
        config(['chat.rate_limits.public_visitor_ip' => 3]);

        foreach (range(1, 3) as $i) {
            $this->withToken('vt_'.str_repeat((string) $i, 40))->getJson('/api/v1/public/conversation')->assertStatus(401);
        }

        $this->withToken('vt_'.str_repeat('9', 40))->getJson('/api/v1/public/conversation')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
        // A real token from the same network is held back too (the network is over its ceiling) ...
        $this->withToken($this->visitorSession($this->widget)->plaintext)->getJson('/api/v1/public/conversation')->assertStatus(429);
        // ... another network is not.
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.50'])->withToken($this->visitorSession($this->widget)->plaintext)->getJson('/api/v1/public/conversation')->assertOk();
    }

    public function test_one_conversation_can_only_hold_so_many_attachment_bytes(): void
    {
        Storage::fake('local');
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, User::factory()->agent()->create());
        $upload = fn () => $this->withToken($token->plaintext)->post("/api/v1/public/conversations/{$chat->ulid}/attachments", ['file' => $this->pngUpload('a.png', 30, 30)], ['Accept' => 'application/json']);

        $first = $upload()->assertCreated();
        $size = (int) $first->json('data.size');
        config(['chat.attachment_max_total_bytes' => $size * 2 + 1]);

        $upload()->assertCreated();
        $upload()->assertStatus(422)
            ->assertJsonPath('error.code', 'attachment_quota_exceeded')
            ->assertJsonStructure(['error' => ['details' => ['file']]]);

        $this->assertSame(2, Attachment::query()->where('conversation_id', $chat->id)->count());
        $this->assertCount(4, Storage::disk('local')->allFiles(), 'the refused upload left nothing on the disk');

        // Another conversation has its own quota.
        $otherToken = $this->visitorSession($this->widget);
        $otherChat = $this->activeChat($otherToken, $this->billing, User::factory()->agent()->create());
        $this->withToken($otherToken->plaintext)->post("/api/v1/public/conversations/{$otherChat->ulid}/attachments", ['file' => $this->pngUpload('a.png', 30, 30)], ['Accept' => 'application/json'])->assertCreated();
    }
}
