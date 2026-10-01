<?php

namespace Tests\Feature\Chat\Api;

use App\Mail\OfflineTicketReply;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * An agent whose account has no real name (a portal user without one carries the address) must never be shown to a visitor by
 * e-mail address: not in the agent card, not in a message, not in the "joined" line and not in the reply e-mail's signature.
 */
class VisitorFacingAgentNameTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->billing, ['name' => 'ann.smith@example.test', 'display_name' => 'ann.smith@example.test', 'email' => 'ann.smith@example.test']);
    }

    public function test_visitors_see_a_name_without_the_address_everywhere_an_agent_is_shown(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->queuedChat($token, $this->billing, [$this->agent]);

        $this->actingAs($this->agent, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/claim")->assertOk()
            // Staff keep seeing the account name.
            ->assertJsonPath('data.assignedAgent.name', 'ann.smith@example.test')
            ->assertJsonPath('data.agent.name', 'Ann Smith');
        $this->actingAs($this->agent, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/messages", ['body' => 'Hello'])->assertCreated();

        $conversation = $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertOk()->assertJsonPath('data.agent.name', 'Ann Smith');
        $messages = $this->withToken($token->plaintext)->getJson("/api/v1/public/conversations/{$chat->ulid}/messages")->assertOk();

        $this->assertSame('Ann Smith joined the chat.', $messages->json('data.0.body'));
        $this->assertSame('Ann Smith', $messages->json('data.1.sender.name'));
        $this->assertStringNotContainsString('@', (string) $conversation->getContent());
        $this->assertStringNotContainsString('@', (string) $messages->getContent());

        // The staff view of the same message carries the account name.
        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$chat->ulid}/messages")->assertOk()->assertJsonPath('data.1.sender.name', 'ann.smith@example.test');
    }

    public function test_the_reply_mail_is_signed_without_the_address(): void
    {
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $reply = Message::factory()->for($ticket)->fromAgent($this->agent)->create(['body' => 'Done.']);

        $text = (new OfflineTicketReply($ticket->fresh(), $reply))->render();

        $this->assertStringContainsString('Ann Smith from', $text);
        $this->assertStringNotContainsString('@', $text);
    }
}
