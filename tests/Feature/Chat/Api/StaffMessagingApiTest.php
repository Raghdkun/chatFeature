<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesDelivered;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Mail\OfflineTicketReply;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * What staff do inside a chat: write, upload, read receipts, typing, and answering an offline ticket (which is e-mailed).
 */
class StaffMessagingApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    private User $colleague;

    private User $admin;

    private IssuedVisitorToken $token;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->billing, ['name' => 'Sara Agent']);
        $this->colleague = $this->availableAgent($this->billing);
        $this->admin = User::factory()->admin()->create(['name' => 'Ada Admin']);
        $this->token = $this->visitorSession($this->widget, ['name' => 'Ann', 'email' => 'ann@example.test']);
        $this->chat = $this->activeChat($this->token, $this->billing, $this->agent);
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function write(User $user, array $payload, ?Conversation $chat = null): TestResponse
    {
        return $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.($chat ?? $this->chat)->ulid.'/messages', $payload);
    }

    public function test_the_agent_writes_and_the_visitors_counter_moves(): void
    {
        Event::fake([MessageCreated::class, UnseenCountChanged::class]);
        $id = (string) Str::ulid();

        $response = $this->write($this->agent, ['client_msg_id' => $id, 'body' => 'Hi Ann, how can I help?'])
            ->assertCreated()
            ->assertJsonPath('data.seq', 1)
            ->assertJsonPath('data.sender.type', 'agent')
            ->assertJsonPath('data.sender.id', $this->agent->id)
            ->assertJsonPath('data.sender.name', 'Sara Agent')
            ->assertJsonPath('data.clientMsgId', $id);

        $this->chat->refresh();
        $this->assertSame(1, $this->chat->unseen_by_visitor);
        $this->assertSame(0, $this->chat->unseen_by_agent);
        $this->assertSame('Hi Ann, how can I help?', $this->chat->last_message_preview);
        Event::assertDispatched(MessageCreated::class, fn (MessageCreated $event): bool => $event->message->ulid === $response->json('data.ulid'));
        Event::assertNotDispatched(UnseenCountChanged::class);

        // A replay is the original.
        $this->write($this->agent, ['client_msg_id' => $id, 'body' => 'again'])->assertOk()->assertJsonPath('data.ulid', $response->json('data.ulid'));
        $this->assertSame(1, $this->chat->fresh()->unseen_by_visitor);

        // The visitor sees the same message without the staff id.
        $visible = $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages")->assertOk();
        $this->assertSame(['type' => 'agent', 'name' => 'Sara Agent', 'avatarUrl' => null], $visible->json('data.0.sender'));
    }

    public function test_only_the_assigned_agent_or_an_admin_may_write(): void
    {
        $this->write($this->colleague, ['body' => 'mine now'])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/messages", ['body' => 'x'])->assertForbidden();

        // An agent who merely holds an offer for a queued chat cannot write into it either.
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->colleague]);
        $this->write($this->colleague, ['body' => 'hello'], $queued)->assertForbidden();

        $this->write($this->admin, ['body' => 'Admin here'])->assertCreated()->assertJsonPath('data.sender.id', $this->admin->id)->assertJsonPath('data.sender.name', 'Ada Admin');
        $this->assertSame(1, Message::query()->count());
    }

    public function test_a_message_to_a_chat_that_is_not_active_is_a_conflict_for_everyone_including_admins(): void
    {
        $ended = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id]);
        $closed = Conversation::factory()->closed($this->agent)->create(['widget_id' => $this->widget->id]);
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing);

        foreach ([$ended, $closed] as $chat) {
            $this->write($this->agent, ['body' => 'x'], $chat)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
            $this->write($this->admin, ['body' => 'x'], $chat)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        }

        $this->write($this->admin, ['body' => 'x'], $queued)->assertStatus(409);
        $this->assertSame(0, Message::query()->count());
    }

    public function test_the_staff_message_is_validated(): void
    {
        $this->write($this->agent, [])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body']]]);
        $this->write($this->agent, ['body' => '   '])->assertStatus(422);
        $this->write($this->agent, ['body' => 'x', 'client_msg_id' => 'nope'])->assertStatus(422);
        $this->write($this->agent, ['attachments' => [(string) Str::ulid()]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['attachments']]]);
    }

    public function test_the_agent_sends_an_image_they_uploaded_and_cannot_use_the_visitors(): void
    {
        $upload = fn (User $user) => $this->actingAs($user, 'sanctum')->post("/api/v1/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload('shot.png')], ['Accept' => 'application/json']);

        $mine = $upload($this->agent)->assertCreated()->assertJsonPath('data.mime', 'image/png');
        $this->assertSame('agent', Attachment::query()->sole()->uploader_type->value);
        $this->assertSame($this->agent->id, Attachment::query()->sole()->uploader_user_id);

        // The visitor's pending upload cannot be attached to an agent message (and the other way round).
        $visitorUpload = $this->withToken($this->token->plaintext)->post("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->assertCreated()->json('data.ulid');
        $this->write($this->agent, ['attachments' => [$visitorUpload]])->assertStatus(422);
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/messages", ['attachments' => [$mine->json('data.ulid')]])->assertStatus(422);

        $this->write($this->agent, ['attachments' => [$mine->json('data.ulid')]])->assertCreated()->assertJsonPath('data.type', 'image')->assertJsonPath('data.attachments.0.ulid', $mine->json('data.ulid'));

        // Staff uploads follow the same access rules as staff messages.
        $upload($this->colleague)->assertForbidden();
        $upload($this->admin)->assertCreated();
    }

    public function test_staff_see_a_conversations_messages_with_the_sender_ids(): void
    {
        Message::factory()->for($this->chat)->create(['body' => 'visitor says hi']);
        Message::factory()->for($this->chat)->fromAgent($this->agent)->create(['body' => 'agent answers']);

        $response = $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}/messages")->assertOk();

        $this->assertSame([1, 2], array_column($response->json('data'), 'seq'));
        $this->assertSame($this->agent->id, $response->json('data.1.sender.id'));
        $this->assertArrayNotHasKey('id', $response->json('data.0.sender'));
        $this->assertNull($response->json('meta.next_cursor'));

        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}/messages?after_seq=1")->assertOk()->assertJsonCount(1, 'data');
        $this->actingAs($this->admin, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}/messages")->assertOk();
        $this->actingAs($this->colleague, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}/messages")->assertForbidden();

        // An agent offered a queued chat may read what the visitor wrote before accepting.
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->colleague]);
        Message::factory()->for($queued)->create(['body' => 'waiting']);
        $this->actingAs($this->colleague, 'sanctum')->getJson("/api/v1/conversations/{$queued->ulid}/messages")->assertOk()->assertJsonPath('data.0.body', 'waiting');
    }

    public function test_the_agents_receipts_mark_the_visitors_messages_and_clear_the_unread_counter(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class, UnseenCountChanged::class]);
        $a = Message::factory()->for($this->chat)->create();
        $b = Message::factory()->for($this->chat)->create();
        $reply = Message::factory()->for($this->chat)->fromAgent($this->agent)->create();
        $this->chat->forceFill(['unseen_by_agent' => 2])->save();
        $receipts = fn (User $user, array $body) => $this->actingAs($user, 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/receipts", $body);

        $receipts($this->agent, ['seen_upto' => 1])->assertNoContent();
        $this->assertNotNull($a->fresh()->seen_at);
        $this->assertNotNull($a->fresh()->delivered_at);
        $this->assertNull($b->fresh()->seen_at);
        $this->assertSame(1, $this->chat->fresh()->unseen_by_agent);
        Event::assertDispatched(MessagesSeen::class, fn (MessagesSeen $event): bool => $event->upToSeq === 1 && $event->by === SenderType::Agent);
        Event::assertNotDispatched(MessagesDelivered::class);
        Event::assertDispatched(UnseenCountChanged::class);

        $receipts($this->agent, ['seen_upto' => 3])->assertNoContent();
        $this->assertNotNull($b->fresh()->seen_at);
        $this->assertNull($reply->fresh()->seen_at, 'the agent never marks their own message');
        $this->assertSame(0, $this->chat->fresh()->unseen_by_agent);
        Event::assertDispatchedTimes(MessagesSeen::class, 2);

        // Only the assigned agent reads the chat: not a colleague, not an admin who is just looking.
        $receipts($this->colleague, ['seen_upto' => 3])->assertForbidden();
        $receipts($this->admin, ['seen_upto' => 3])->assertForbidden();
        $receipts($this->agent, [])->assertStatus(422);
    }

    public function test_the_agents_delivery_receipt_is_announced_to_the_conversation_without_marking_anything_read(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class, UnseenCountChanged::class]);
        $a = Message::factory()->for($this->chat)->create();
        $this->chat->forceFill(['unseen_by_agent' => 1])->save();
        $url = "/api/v1/conversations/{$this->chat->ulid}/receipts";

        $this->actingAs($this->agent, 'sanctum')->postJson($url, ['delivered_upto' => 1])->assertNoContent();

        $this->assertNotNull($a->fresh()->delivered_at);
        $this->assertNull($a->fresh()->seen_at);
        $this->assertSame(1, $this->chat->fresh()->unseen_by_agent);
        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 1 && $event->by === SenderType::Agent);
        Event::assertNotDispatched(MessagesSeen::class);

        $this->actingAs($this->agent, 'sanctum')->postJson($url, ['delivered_upto' => 1])->assertNoContent();
        Event::assertDispatchedTimes(MessagesDelivered::class, 1);

        // Neither a colleague nor an admin who is just looking may report receipts for this chat.
        $this->actingAs($this->colleague, 'sanctum')->postJson($url, ['delivered_upto' => 1])->assertForbidden();
        $this->actingAs($this->admin, 'sanctum')->postJson($url, ['delivered_upto' => 1])->assertForbidden();
    }

    public function test_the_agent_can_report_typing_in_their_active_chat_only(): void
    {
        Event::fake([TypingBroadcast::class]);
        $typing = fn (User $user, Conversation $chat, bool $on = true) => $this->actingAs($user, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/typing", ['typing' => $on]);

        $typing($this->agent, $this->chat)->assertNoContent();
        $typing($this->agent, $this->chat, false)->assertNoContent();
        Event::assertDispatchedTimes(TypingBroadcast::class, 2);
        Event::assertDispatched(TypingBroadcast::class, fn (TypingBroadcast $event): bool => $event->conversation === $this->chat->ulid && $event->actor === SenderType::Agent && $event->typing === true);

        $typing($this->colleague, $this->chat)->assertForbidden();
        $typing($this->admin, $this->chat)->assertForbidden();
        $this->actingAs($this->agent, 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/typing", [])->assertStatus(422);

        $ended = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id]);
        $typing($this->agent, $ended)->assertStatus(409);
        Event::assertDispatchedTimes(TypingBroadcast::class, 2);
    }

    public function test_a_reply_to_an_offline_ticket_is_stored_and_e_mailed_to_the_visitor(): void
    {
        Mail::fake();
        $ticket = $this->offlineTicket();

        $response = $this->write($this->agent, ['body' => 'We refunded the invoice.'], $ticket)->assertCreated();

        Mail::assertQueued(OfflineTicketReply::class, function (OfflineTicketReply $mail) use ($ticket, $response): bool {
            return $mail->hasTo('ann@example.test')
                && $mail->conversation->is($ticket)
                && $mail->reply->ulid === $response->json('data.ulid')
                && str_contains($mail->envelope()->subject, $ticket->ticket_no);
        });
        Mail::assertQueuedCount(1);
        $this->assertSame(2, $ticket->fresh()->last_seq, 'the visitor message is 1, the reply is 2');

        // A live chat reply is not e-mailed.
        $this->write($this->agent, ['body' => 'hello'])->assertCreated();
        Mail::assertQueuedCount(1);
    }

    public function test_the_reply_mail_is_a_plain_text_message_from_the_agent(): void
    {
        $ticket = $this->offlineTicket();
        $reply = Message::factory()->for($ticket)->fromAgent($this->agent)->create(['body' => "Dear Ann & co,\nit's done <b>today</b>."]);
        $mail = new OfflineTicketReply($ticket->fresh(), $reply);

        $text = $mail->render();

        $this->assertStringContainsString('Hello Ann,', $text);
        $this->assertStringContainsString("Dear Ann & co,\nit's done <b>today</b>.", $text, 'plain text: nothing is HTML-escaped');
        $this->assertStringContainsString('Sara Agent', $text);
        $this->assertStringContainsString($ticket->ticket_no, $text);
        $this->assertSame('Re: your message (ticket '.$ticket->ticket_no.')', $mail->envelope()->subject);
        $this->assertSame('chat.offline_reply', $mail->content()->text);
    }

    public function test_the_greeting_of_the_reply_mail_is_one_line_whatever_the_stored_name(): void
    {
        $ticket = $this->offlineTicket();
        // Older rows or rows written around the model: a line break and a header-looking line in the name.
        DB::table('visitors')->where('id', $ticket->visitor_id)->update(['name' => "Ann\r\nBcc: victim@example.test\u{202E}"]);
        $reply = Message::factory()->for($ticket)->fromAgent($this->agent)->create(['body' => 'Done.']);

        $text = (new OfflineTicketReply($ticket->fresh(), $reply))->render();

        $this->assertStringStartsWith('Hello Ann Bcc: victim@example.test,'."\n", $text);
        $this->assertStringNotContainsString("\u{202E}", $text);
    }

    public function test_a_mail_that_cannot_be_queued_does_not_fail_the_reply(): void
    {
        $ticket = $this->offlineTicket();
        Mail::shouldReceive('to')->andThrow(new \RuntimeException('smtp is down'));
        Log::spy();

        $response = $this->write($this->agent, ['body' => 'We refunded the invoice.'], $ticket)->assertCreated();

        // The message is stored and visible; the failure is reported and logged, not a 500 the agent would answer by sending it again.
        $this->assertSame('We refunded the invoice.', Message::query()->where('ulid', $response->json('data.ulid'))->sole()->body);
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message, array $context): bool => str_contains($message, 'could not be e-mailed') && $context['conversation'] === $ticket->ulid)->once();
    }

    public function test_a_visitor_without_an_address_gets_no_mail_and_an_unclaimed_ticket_takes_no_reply(): void
    {
        Mail::fake();
        $token = $this->visitorSession($this->widget, ['email' => null]);
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);

        $this->write($this->agent, ['body' => 'Reply'], $ticket)->assertCreated();
        Mail::assertNothingQueued();

        $unclaimed = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $this->write($this->agent, ['body' => 'Reply'], $unclaimed)->assertForbidden();
        $this->write($this->admin, ['body' => 'Reply'], $unclaimed)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        Mail::assertNothingQueued();
    }

    private function offlineTicket(): Conversation
    {
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create([
            'widget_id' => $this->widget->id,
            'visitor_id' => $this->token->session->visitor_id,
            'visitor_session_id' => $this->token->session->id,
            'idle_expires_at' => null,
        ]);
        Message::factory()->for($ticket)->create(['body' => 'Please refund my invoice']);

        return $ticket;
    }

    public function test_offers_are_not_needed_to_read_an_offline_ticket(): void
    {
        $ticket = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        Message::factory()->for($ticket)->create();
        $this->assertSame(0, ConversationOffer::query()->count());

        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$ticket->ulid}/messages")->assertOk()->assertJsonCount(1, 'data');
    }
}
