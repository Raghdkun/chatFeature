<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Actions\UploadAttachment;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesDelivered;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Domain\Chat\Services\MessageText;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\Setting;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * Visitor messages: numbering, idempotency, state rules, plain-text cleaning, the sync call (`after_seq`), receipts and typing.
 */
class PublicMessagesApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    private IssuedVisitorToken $token;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = User::factory()->agent()->create(['name' => 'Sara Agent', 'email' => 'sara@staff.test']);
        $this->token = $this->visitorSession($this->widget, ['name' => 'Ann']);
        $this->chat = $this->activeChat($this->token, $this->billing, $this->agent);
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function send(array $payload, ?Conversation $chat = null, ?IssuedVisitorToken $token = null): TestResponse
    {
        return $this->withToken(($token ?? $this->token)->plaintext)->postJson('/api/v1/public/conversations/'.($chat ?? $this->chat)->ulid.'/messages', $payload);
    }

    private function ulid(): string
    {
        return (string) Str::ulid();
    }

    public function test_a_message_is_numbered_stored_and_announced(): void
    {
        Event::fake([MessageCreated::class, UnseenCountChanged::class, ConversationUpdated::class]);
        $id = $this->ulid();

        $response = $this->send(['client_msg_id' => $id, 'body' => "  Hello\r\nworld  "])
            ->assertCreated()
            ->assertJsonPath('data.seq', 1)
            ->assertJsonPath('data.body', "Hello\nworld")
            ->assertJsonPath('data.clientMsgId', $id)
            ->assertJsonPath('data.type', 'text')
            ->assertJsonPath('data.conversation', $this->chat->ulid)
            ->assertJsonPath('data.sender', ['type' => 'visitor', 'name' => 'Ann', 'avatarUrl' => null])
            ->assertJsonPath('data.attachments', [])
            ->assertJsonPath('data.deliveredAt', null)
            ->assertJsonPath('data.seenAt', null);

        // Visitor-safe: no staff ids anywhere in the payload.
        $this->assertArrayNotHasKey('id', $response->json('data.sender'));

        $this->chat->refresh();
        $this->assertSame(1, $this->chat->last_seq);
        $this->assertSame(1, $this->chat->unseen_by_agent);
        $this->assertSame(0, $this->chat->unseen_by_visitor);
        $this->assertSame('Hello world', $this->chat->last_message_preview);
        $this->assertNotNull($this->chat->last_message_at);

        Event::assertDispatched(MessageCreated::class, fn (MessageCreated $event): bool => $event->message->ulid === $response->json('data.ulid'));
        Event::assertDispatched(UnseenCountChanged::class);
        Event::assertDispatched(ConversationUpdated::class);

        $this->send(['body' => 'second'])->assertCreated()->assertJsonPath('data.seq', 2)->assertJsonPath('data.clientMsgId', null);
        $this->assertSame(2, $this->chat->fresh()->unseen_by_agent);
    }

    public function test_a_message_moves_the_idle_deadline_and_nothing_else_does(): void
    {
        $this->travelTo(now()->addMinutes(30));
        $this->send(['body' => 'still here'])->assertCreated();

        $this->assertEqualsWithDelta(now()->addMinutes(120)->getTimestamp(), $this->chat->fresh()->idle_expires_at->getTimestamp(), 2);

        $deadline = $this->chat->fresh()->idle_expires_at;
        $this->travelTo(now()->addMinutes(10));
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/typing", ['typing' => true])->assertNoContent();
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => 0, 'delivered_upto' => 0])->assertNoContent();

        $this->assertTrue($deadline->equalTo($this->chat->fresh()->idle_expires_at));
    }

    public function test_a_replayed_client_msg_id_returns_the_original_message(): void
    {
        $id = $this->ulid();

        $first = $this->send(['client_msg_id' => $id, 'body' => 'once'])->assertCreated();
        $replay = $this->send(['client_msg_id' => $id, 'body' => 'once, again'])->assertOk();

        $this->assertSame($first->json('data.ulid'), $replay->json('data.ulid'));
        $this->assertSame('once', $replay->json('data.body'));
        $this->assertSame(1, Message::query()->where('conversation_id', $this->chat->id)->count());
        $this->assertSame(1, $this->chat->fresh()->unseen_by_agent);

        // It is still the original after the chat ended.
        $this->chat->forceFill(['status' => 'ended'])->save();
        $this->send(['client_msg_id' => $id, 'body' => 'once'])->assertOk()->assertJsonPath('data.ulid', $first->json('data.ulid'));
        $this->send(['client_msg_id' => $this->ulid(), 'body' => 'new'])->assertStatus(409);
    }

    public function test_the_same_client_msg_id_in_another_conversation_is_a_different_message(): void
    {
        $id = $this->ulid();
        $other = $this->visitorSession($this->widget);
        $otherChat = $this->activeChat($other, $this->billing, $this->agent);

        $this->send(['client_msg_id' => $id, 'body' => 'a'])->assertCreated();
        $this->send(['client_msg_id' => $id, 'body' => 'b'], $otherChat, $other)->assertCreated();
    }

    public function test_only_an_active_live_chat_takes_messages(): void
    {
        $queuedToken = $this->visitorSession($this->widget);
        $queued = $this->queuedChat($queuedToken, $this->billing);
        $ended = Conversation::factory()->ended()->create(['widget_id' => $this->widget->id, 'visitor_id' => $this->token->session->visitor_id, 'visitor_session_id' => $this->token->session->id]);
        $offline = Conversation::factory()->offline()->create(['widget_id' => $this->widget->id, 'visitor_id' => $this->token->session->visitor_id, 'visitor_session_id' => $this->token->session->id]);
        $offlineActive = Conversation::factory()->offline()->create(['widget_id' => $this->widget->id, 'visitor_id' => $this->token->session->visitor_id, 'visitor_session_id' => $this->token->session->id, 'status' => 'active', 'assigned_agent_id' => $this->agent->id]);

        $this->send(['body' => 'hi'], $queued, $queuedToken)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        $this->send(['body' => 'hi'], $ended)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        $this->send(['body' => 'hi'], $offline)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        // The visitor of an offline ticket is gone: only staff write there.
        $this->send(['body' => 'hi'], $offlineActive)->assertStatus(409);

        $this->assertSame(0, Message::query()->whereIn('conversation_id', [$queued->id, $ended->id, $offline->id, $offlineActive->id])->count());
    }

    public function test_the_message_is_validated_and_cleaned(): void
    {
        settings()->set('chat.max_message_length', 100);

        $this->send([])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body']]]);
        $this->send(['body' => "  \t\n  "])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body']]]);
        $this->send(['body' => "\x00\x07\u{202E}"])->assertStatus(422);
        $this->send(['body' => str_repeat('x', 101)])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body']]]);
        $this->send(['body' => 'ok', 'client_msg_id' => 'not-a-ulid'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['client_msg_id']]]);
        $this->send(['body' => ['array']])->assertStatus(422);
        $this->send(['attachments' => array_map(fn () => $this->ulid(), range(1, 6))])->assertStatus(422);

        // Control characters and bidi overrides are dropped, markup is kept as the text it is.
        $this->send(['body' => "Hi\x00 <b>there</b>\u{202E}!"])->assertCreated()->assertJsonPath('data.body', 'Hi <b>there</b>!');
        $this->send(['body' => str_repeat('x', 100)])->assertCreated();
        $this->assertSame(2, Message::query()->count());
    }

    public function test_a_stored_length_above_the_hard_limit_is_clamped(): void
    {
        // A value an older version stored (the setting is validated up to 16 000 now): the 4-byte-character worst case must still fit
        // the TEXT column, so the request limit never exceeds MessageText::HARD_MAX_LENGTH.
        settings()->set('chat.max_message_length', 5000);
        Setting::query()->where('key', 'chat.max_message_length')->update(['value' => json_encode(20000)]);
        settings()->forget();
        $this->assertSame(20000, settings()->int('chat.max_message_length'));
        $this->assertSame(MessageText::HARD_MAX_LENGTH, MessageText::maxLength());

        $this->send(['body' => str_repeat('x', MessageText::HARD_MAX_LENGTH + 1)])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body']]]);
        $this->send(['body' => str_repeat('😀', MessageText::HARD_MAX_LENGTH)])->assertCreated();
        $this->assertSame(MessageText::HARD_MAX_LENGTH, mb_strlen((string) Message::query()->latest('id')->value('body')));
    }

    public function test_images_staged_and_then_removed_never_block_the_chat_for_good(): void
    {
        config(['chat.rate_limits.public_upload_session' => 100]);
        $uploaded = [];

        // Twelve add-and-remove rounds: nothing references these uploads, and the client has no way to take them back.
        foreach (range(1, 12) as $unused) {
            $uploaded[] = $this->withToken($this->token->plaintext)->post("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])
                ->assertCreated()->json('data.ulid');
        }

        $pending = Attachment::query()->where('conversation_id', $this->chat->id)->whereNull('message_id');

        $this->assertSame(UploadAttachment::MAX_PENDING, $pending->count(), 'the oldest went, the newest are kept');
        $this->assertSame(array_slice($uploaded, -UploadAttachment::MAX_PENDING), $pending->orderBy('id')->pluck('ulid')->all());
        $this->send(['attachments' => [end($uploaded)], 'body' => 'this one'])->assertCreated();
    }

    public function test_an_image_message_references_uploaded_attachments_once(): void
    {
        $upload = $this->withToken($this->token->plaintext)->post("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->assertCreated();
        $attachment = $upload->json('data.ulid');

        $sent = $this->send(['attachments' => [$attachment], 'body' => 'look'])->assertCreated()
            ->assertJsonPath('data.type', 'image')
            ->assertJsonPath('data.attachments.0.ulid', $attachment)
            ->assertJsonPath('data.attachments.0.mime', 'image/png');
        $this->assertSame(Message::query()->sole()->id, Attachment::query()->sole()->message_id);
        $this->assertSame('look', $this->chat->fresh()->last_message_preview);
        $this->assertStringNotContainsString('path', (string) $sent->getContent());

        // An attachment belongs to one message; a stranger's or an unknown one is refused.
        $this->send(['attachments' => [$attachment]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['attachments']]]);
        $this->send(['attachments' => [$this->ulid()]])->assertStatus(422);

        $other = $this->visitorSession($this->widget);
        $otherChat = $this->activeChat($other, $this->billing, $this->agent);
        $foreign = $this->withToken($other->plaintext)->post("/api/v1/public/conversations/{$otherChat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->assertCreated()->json('data.ulid');
        $this->send(['attachments' => [$foreign]])->assertStatus(422);
        $this->assertNull(Attachment::query()->where('ulid', $foreign)->value('message_id'));

        // An image-only message previews as "Image".
        $second = $this->withToken($this->token->plaintext)->post("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->json('data.ulid');
        $this->send(['attachments' => [$second]])->assertCreated();
        $this->assertSame('Image', $this->chat->fresh()->last_message_preview);
    }

    public function test_the_attachments_keep_the_order_the_visitor_picked_not_the_order_the_uploads_finished(): void
    {
        $upload = fn (): string => $this->withToken($this->token->plaintext)->post("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->assertCreated()->json('data.ulid');
        [$first, $second, $third] = [$upload(), $upload(), $upload()];

        $sent = $this->send(['attachments' => [$third, $first, $second]])->assertCreated();

        $this->assertSame([$third, $first, $second], $sent->json('data.attachments.*.ulid'));
        $this->assertSame([0, 1, 2], array_map(fn (string $ulid): int => Attachment::query()->where('ulid', $ulid)->value('position'), [$third, $first, $second]));

        $listed = $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages")->assertOk();
        $this->assertSame([$third, $first, $second], $listed->json('data.0.attachments.*.ulid'));
    }

    public function test_the_sync_call_returns_messages_after_a_number_in_order_with_paging(): void
    {
        foreach (range(1, 5) as $i) {
            $this->send(['body' => "m{$i}"])->assertCreated();
        }
        Message::factory()->for($this->chat)->fromAgent($this->agent)->create(['body' => 'from agent']);
        Message::factory()->for($this->chat)->system('Sara joined the chat.')->create();

        $all = $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages")->assertOk();
        $this->assertSame(range(1, 7), array_column($all->json('data'), 'seq'));
        $this->assertNull($all->json('meta.next_cursor'));
        $this->assertSame(['visitor', 'visitor', 'visitor', 'visitor', 'visitor', 'agent', 'system'], array_map(fn (array $m): string => $m['sender']['type'], $all->json('data')));

        // The agent is shown by name and avatar only: no id, no e-mail.
        $agentMessage = $all->json('data.5');
        $this->assertSame(['type' => 'agent', 'name' => 'Sara Agent', 'avatarUrl' => null], $agentMessage['sender']);
        $this->assertStringNotContainsString('sara@staff.test', (string) $all->getContent());

        $page = $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages?after_seq=2&limit=3")->assertOk();
        $this->assertSame([3, 4, 5], array_column($page->json('data'), 'seq'));
        $this->assertSame('5', $page->json('meta.next_cursor'));

        $rest = $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages?after_seq=5&limit=3")->assertOk();
        $this->assertSame([6, 7], array_column($rest->json('data'), 'seq'));
        $this->assertNull($rest->json('meta.next_cursor'));

        $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages?after_seq=7")->assertOk()->assertJsonPath('data', []);
        $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages?limit=500")->assertStatus(422);
        $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages?after_seq=-1")->assertStatus(422);
    }

    public function test_the_visitor_reports_receipts_for_the_agents_messages(): void
    {
        Event::fake([MessagesDelivered::class, MessagesSeen::class, UnseenCountChanged::class]);
        $a = Message::factory()->for($this->chat)->fromAgent($this->agent)->create();
        $b = Message::factory()->for($this->chat)->fromAgent($this->agent)->create();
        $own = Message::factory()->for($this->chat)->create();
        $this->chat->forceFill(['unseen_by_visitor' => 2])->save();

        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['delivered_upto' => 2])->assertNoContent();
        $this->assertNotNull($a->fresh()->delivered_at);
        $this->assertNotNull($b->fresh()->delivered_at);
        $this->assertNull($a->fresh()->seen_at);
        Event::assertNotDispatched(MessagesSeen::class);
        Event::assertDispatchedTimes(MessagesDelivered::class, 1);
        Event::assertDispatched(MessagesDelivered::class, fn (MessagesDelivered $event): bool => $event->upToSeq === 2 && $event->by === SenderType::Visitor && $event->conversation->is($this->chat));

        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => 1])->assertNoContent();
        $this->assertNotNull($a->fresh()->seen_at);
        $this->assertNull($b->fresh()->seen_at);
        $this->assertSame(1, $this->chat->fresh()->unseen_by_visitor);
        Event::assertDispatchedTimes(MessagesSeen::class, 1);
        Event::assertDispatched(MessagesSeen::class, fn (MessagesSeen $event): bool => $event->upToSeq === 1 && $event->by === SenderType::Visitor);

        // Beyond the last message is clamped; the visitor's own message never gets a receipt from them.
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => 999])->assertNoContent();
        $this->assertNotNull($b->fresh()->seen_at);
        $this->assertNull($own->fresh()->seen_at);
        $this->assertSame(0, $this->chat->fresh()->unseen_by_visitor);
        Event::assertDispatchedTimes(MessagesSeen::class, 2);

        // Repeating a receipt changes nothing and dispatches nothing; reading was already announced as seen, not as delivered again.
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => 999])->assertNoContent();
        Event::assertDispatchedTimes(MessagesSeen::class, 2);
        Event::assertDispatchedTimes(MessagesDelivered::class, 1);
        // The agent's unseen counter is for agent receipts only.
        Event::assertNotDispatched(UnseenCountChanged::class);
    }

    public function test_receipts_need_a_number(): void
    {
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", [])->assertStatus(422);
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => 'x'])->assertStatus(422);
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/receipts", ['seen_upto' => -3])->assertStatus(422);
    }

    public function test_typing_is_validated_published_and_only_for_an_active_chat(): void
    {
        Event::fake([TypingBroadcast::class]);

        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/typing", ['typing' => true])->assertNoContent();
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/typing", ['typing' => false])->assertNoContent();
        Event::assertDispatchedTimes(TypingBroadcast::class, 2);
        Event::assertDispatched(TypingBroadcast::class, fn (TypingBroadcast $event): bool => $event->conversation === $this->chat->ulid && $event->actor === SenderType::Visitor && $event->typing === true);
        Event::assertDispatched(TypingBroadcast::class, fn (TypingBroadcast $event): bool => $event->typing === false);

        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/typing", [])->assertStatus(422);

        $queuedToken = $this->visitorSession($this->widget);
        $queued = $this->queuedChat($queuedToken, $this->billing);
        $this->withToken($queuedToken->plaintext)->postJson("/api/v1/public/conversations/{$queued->ulid}/typing", ['typing' => true])->assertStatus(409);

        // Nothing was stored and nothing else was sent.
        Event::assertDispatchedTimes(TypingBroadcast::class, 2);
        $this->assertSame(0, Message::query()->count());
    }

    public function test_messages_are_rate_limited_per_session(): void
    {
        config(['chat.rate_limits.public_message_session' => 2]);

        $this->send(['body' => 'one'])->assertCreated();
        $this->send(['body' => 'two'])->assertCreated();
        $this->send(['body' => 'three'])->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');

        // Reads and another visitor are not affected.
        $this->withToken($this->token->plaintext)->getJson("/api/v1/public/conversations/{$this->chat->ulid}/messages")->assertOk();
        $other = $this->visitorSession($this->widget);
        $this->send(['body' => 'hi'], $this->activeChat($other, $this->billing, $this->agent), $other)->assertCreated();
    }
}
