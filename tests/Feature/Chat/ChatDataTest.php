<?php

namespace Tests\Feature\Chat;

use App\Data\Chat\AgentRefData;
use App\Data\Chat\AttachmentData;
use App\Data\Chat\CategoryRefData;
use App\Data\Chat\ConversationPublicData;
use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\MessageData;
use App\Data\Chat\OfferData;
use App\Data\Chat\PresenceData;
use App\Data\Chat\PresenceMemberData;
use App\Data\Chat\RatingData;
use App\Data\Chat\StaffAgentRefData;
use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Models\AgentPresence;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Spatie\LaravelData\Data;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\FakeAttachmentUrls;
use Tests\TestCase;

/**
 * The chat Data classes against docs/contracts/realtime-events.md: exact key sets (camelCase), ISO timestamps, and what a
 * visitor must never receive.
 */
class ChatDataTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase;

    private User $agent;

    private Category $category;

    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->app->instance(AttachmentUrls::class, new FakeAttachmentUrls);

        $this->agent = User::factory()->create([
            'name' => 'Samuel Internal-Legal-Name',
            'display_name' => 'Sam',
            'email' => 'sam.agent@company.example',
            'avatar_path' => 'avatars/sam.png',
        ]);
        $this->category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $this->conversation = Conversation::factory()->active($this->agent)->forCategory($this->category)->create([
            'last_seq' => 3,
            'unseen_by_agent' => 2,
            'last_message_at' => now(),
            'last_message_preview' => 'Where is my invoice?',
        ]);
        $this->conversation->visitor->forceFill([
            'name' => 'Vera Visitor',
            'email' => 'vera@visitor.example',
            'phone' => '+1 555 0100',
            'verified' => true,
            'meta' => ['plan' => 'pro'],
        ])->save();
    }

    private function avatarUrl(): string
    {
        return Storage::disk('public')->url('avatars/sam.png');
    }

    /**
     * @return array<string, mixed>
     */
    private function toPayload(Data $data): array
    {
        /** @var array<string, mixed> $payload */
        $payload = json_decode($data->toJson(), true, 512, JSON_THROW_ON_ERROR);

        return $payload;
    }

    /**
     * @param  array<array-key, mixed>  $payload
     * @param  list<string>  $keys
     */
    private function assertKeys(array $keys, array $payload, string $what = 'payload'): void
    {
        $actual = array_keys($payload);
        sort($actual);
        sort($keys);

        $this->assertSame($keys, $actual, "{$what} keys");
    }

    /**
     * @param  array<array-key, mixed>  $payload
     * @return list<string>
     */
    private function allKeys(array $payload): array
    {
        $keys = [];

        foreach ($payload as $key => $value) {
            if (is_string($key)) {
                $keys[] = $key;
            }

            if (is_array($value)) {
                $keys = [...$keys, ...$this->allKeys($value)];
            }
        }

        return $keys;
    }

    private function fresh(): Conversation
    {
        return Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($this->conversation->id);
    }

    // ---- Message -----------------------------------------------------------------------------------------------------

    public function test_a_visitor_message_has_exactly_the_contract_keys_and_no_staff_id(): void
    {
        $message = Message::factory()->for($this->conversation)->withClientMsgId('01JABCDEFGHJKMNPQRSTVWXYZ0')->create(['body' => 'Hello there']);

        $payload = $this->toPayload(MessageData::fromModel($message));

        $this->assertKeys(['ulid', 'seq', 'conversation', 'sender', 'type', 'body', 'attachments', 'clientMsgId', 'createdAt', 'deliveredAt', 'seenAt'], $payload);
        $this->assertSame($message->ulid, $payload['ulid']);
        $this->assertSame(1, $payload['seq']);
        $this->assertSame($this->conversation->ulid, $payload['conversation']);
        $this->assertSame(['type' => 'visitor', 'name' => 'Vera Visitor', 'avatarUrl' => null], $payload['sender']);
        $this->assertSame('text', $payload['type']);
        $this->assertSame('Hello there', $payload['body']);
        $this->assertSame([], $payload['attachments']);
        $this->assertSame('01JABCDEFGHJKMNPQRSTVWXYZ0', $payload['clientMsgId']);
        $this->assertNull($payload['deliveredAt']);
        $this->assertNull($payload['seenAt']);
    }

    public function test_an_agent_message_shows_the_public_face_to_visitors_and_the_id_to_staff(): void
    {
        $message = Message::factory()->for($this->conversation)->fromAgent($this->agent)->create();

        $visitorView = $this->toPayload(MessageData::fromModel($message));
        $staffView = $this->toPayload(MessageData::fromModel($message, forStaff: true));

        $this->assertSame(['type' => 'agent', 'name' => 'Sam', 'avatarUrl' => $this->avatarUrl()], $visitorView['sender']);
        $this->assertSame(['type' => 'agent', 'name' => 'Sam', 'avatarUrl' => $this->avatarUrl(), 'id' => $this->agent->id], $staffView['sender']);
        $this->assertSame(array_diff_key($staffView, ['sender' => 1]), array_diff_key($visitorView, ['sender' => 1]));
    }

    public function test_system_messages_have_no_name_and_no_id(): void
    {
        $message = Message::factory()->for($this->conversation)->system('Sam joined the chat.')->create();

        $this->assertSame(['type' => 'system', 'name' => null, 'avatarUrl' => null], $this->toPayload(MessageData::fromModel($message, forStaff: true))['sender']);
        $this->assertSame('system', $this->toPayload(MessageData::fromModel($message))['type']);
    }

    public function test_an_image_message_lists_its_attachments_with_signed_urls_only(): void
    {
        $message = Message::factory()->for($this->conversation)->image()->create();
        $attachment = $message->attachments()->firstOrFail();

        $payload = $this->toPayload(MessageData::fromModel($message));

        $this->assertSame('image', $payload['type']);
        $this->assertNull($payload['body']);
        $this->assertCount(1, $payload['attachments']);
        $this->assertSame([
            'ulid' => $attachment->ulid,
            'mime' => 'image/webp',
            'size' => 48_213,
            'width' => 640,
            'height' => 480,
            'url' => 'https://files.test/attachments/'.$attachment->ulid.'?signature=fake',
            'thumbUrl' => 'https://files.test/attachments/'.$attachment->ulid.'?thumb=1&signature=fake',
        ], $payload['attachments'][0]);
    }

    public function test_attachment_data_hides_storage_details_and_handles_a_missing_thumbnail(): void
    {
        $attachment = Attachment::factory()->create(['thumb_path' => null]);

        $payload = $this->toPayload(AttachmentData::fromModel($attachment));
        $json = (string) json_encode($payload);

        $this->assertKeys(['ulid', 'mime', 'size', 'width', 'height', 'url', 'thumbUrl'], $payload);
        $this->assertNull($payload['thumbUrl']);

        foreach (['chat/attachments', $attachment->sha256, 'screenshot.png', '"local"', 'path', 'disk'] as $secret) {
            $this->assertStringNotContainsString($secret, $json);
        }
    }

    public function test_timestamps_are_iso_8601_utc_with_milliseconds(): void
    {
        $this->travelTo('2026-11-20 10:30:15');
        $message = Message::factory()->for($this->conversation)->seen()->create();

        $payload = $this->toPayload(MessageData::fromModel($message->fresh() ?? $message));

        $this->assertSame('2026-11-20T10:30:15.000Z', $payload['createdAt']);
        $this->assertSame('2026-11-20T10:30:15.000Z', $payload['deliveredAt']);
        $this->assertSame('2026-11-20T10:30:15.000Z', $payload['seenAt']);
    }

    // ---- Conversation ------------------------------------------------------------------------------------------------

    public function test_the_public_conversation_has_exactly_the_contract_keys(): void
    {
        $payload = $this->toPayload(ConversationPublicData::fromModel($this->fresh()));

        $this->assertKeys(['ulid', 'ticketNo', 'status', 'type', 'category', 'agent', 'createdAt', 'endedAt', 'ratingRequested', 'lastSeq'], $payload);
        $this->assertSame($this->conversation->ulid, $payload['ulid']);
        $this->assertSame($this->conversation->ticket_no, $payload['ticketNo']);
        $this->assertSame('active', $payload['status']);
        $this->assertSame('live', $payload['type']);
        $this->assertSame(['slug' => 'billing', 'label' => 'Billing'], $payload['category']);
        $this->assertSame(['name' => 'Sam', 'avatarUrl' => $this->avatarUrl()], $payload['agent']);
        $this->assertNull($payload['endedAt']);
        $this->assertFalse($payload['ratingRequested']);
        $this->assertSame(3, $payload['lastSeq']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/D', $payload['createdAt']);
    }

    public function test_a_queued_conversation_without_category_or_agent_has_nulls(): void
    {
        $queued = Conversation::factory()->create();

        $payload = $this->toPayload(ConversationPublicData::fromModel($queued));

        $this->assertNull($payload['category']);
        $this->assertNull($payload['agent']);
        $this->assertSame('queued', $payload['status']);
    }

    public function test_an_ended_conversation_reports_when_it_ended_and_that_a_rating_is_wanted(): void
    {
        $ended = Conversation::factory()->ended($this->agent)->create();

        $payload = $this->toPayload(ConversationPublicData::fromModel($ended->fresh() ?? $ended));

        $this->assertSame('ended', $payload['status']);
        $this->assertNotNull($payload['endedAt']);
        $this->assertTrue($payload['ratingRequested']);
    }

    public function test_the_staff_conversation_is_the_public_one_plus_the_documented_extras(): void
    {
        $conversation = $this->fresh();
        $public = $this->toPayload(ConversationPublicData::fromModel($conversation));
        $staff = $this->toPayload(ConversationStaffData::fromModel($conversation));

        $this->assertKeys([...array_keys($public), 'visitor', 'widget', 'assignedAgent', 'unseenByAgent', 'claimedAt', 'lastMessageAt', 'lastMessagePreview', 'queueExpiresAt', 'pageUrl', 'pageTitle'], $staff);

        foreach ($public as $key => $value) {
            $this->assertSame($value, $staff[$key], "staff payload repeats {$key}");
        }

        $this->assertSame([
            'ulid' => $conversation->visitor->ulid,
            'name' => 'Vera Visitor',
            'email' => 'vera@visitor.example',
            'phone' => '+1 555 0100',
            'verified' => true,
            'meta' => ['plan' => 'pro'],
        ], $staff['visitor']);
        $this->assertSame(['ulid' => $conversation->widget->ulid, 'name' => $conversation->widget->name], $staff['widget']);
        $this->assertSame(['id' => $this->agent->id, 'name' => 'Sam'], $staff['assignedAgent']);
        $this->assertSame(2, $staff['unseenByAgent']);
        $this->assertNotNull($staff['claimedAt']);
        $this->assertNotNull($staff['lastMessageAt']);
        $this->assertSame('Where is my invoice?', $staff['lastMessagePreview']);
    }

    public function test_the_staff_conversation_carries_the_page_of_the_session_and_the_queue_deadline(): void
    {
        $this->conversation->visitorSession?->forceFill(['page_url' => 'https://shop.example/pricing', 'page_title' => 'Pricing'])->save();
        $this->conversation->forceFill(['queue_expires_at' => '2026-10-01 12:00:30'])->save();

        $staff = $this->toPayload(ConversationStaffData::fromModel($this->fresh()));

        $this->assertSame('https://shop.example/pricing', $staff['pageUrl']);
        $this->assertSame('Pricing', $staff['pageTitle']);
        $this->assertSame('2026-10-01T12:00:30.000Z', $staff['queueExpiresAt']);
    }

    public function test_visitor_meta_is_always_a_json_object(): void
    {
        $this->conversation->visitor->forceFill(['meta' => null])->save();

        $json = ConversationStaffData::fromModel($this->fresh())->toJson();

        $this->assertStringContainsString('"meta":{}', $json);
    }

    public function test_the_staff_conversation_of_a_queued_unassigned_chat(): void
    {
        $queued = Conversation::factory()->offline()->create();

        $payload = $this->toPayload(ConversationStaffData::fromModel($queued));

        $this->assertNull($payload['assignedAgent']);
        $this->assertNull($payload['claimedAt']);
        $this->assertNull($payload['lastMessageAt']);
        $this->assertNull($payload['lastMessagePreview']);
        $this->assertSame(0, $payload['unseenByAgent']);
        $this->assertSame('offline', $payload['type']);
    }

    // ---- Privacy -----------------------------------------------------------------------------------------------------

    public function test_nothing_a_visitor_receives_leaks_ids_emails_or_internal_fields(): void
    {
        $conversation = $this->fresh();
        $image = Message::factory()->for($this->conversation)->fromAgent($this->agent)->image()->create();
        $text = Message::factory()->for($this->conversation)->fromAgent($this->agent)->create(['body' => 'Looking into it']);
        $mine = Message::factory()->for($this->conversation)->create();

        $payloads = [
            'conversation' => $this->toPayload(ConversationPublicData::fromModel($conversation)),
            'agent' => $this->toPayload(AgentRefData::fromModel($this->agent)),
            'image message' => $this->toPayload(MessageData::fromModel($image)),
            'agent message' => $this->toPayload(MessageData::fromModel($text)),
            'visitor message' => $this->toPayload(MessageData::fromModel($mine)),
        ];

        $forbiddenKeys = [
            'id', 'userId', 'email', 'phone', 'meta', 'visitor', 'widget', 'assignedAgent', 'unseenByAgent', 'claimedAt', 'lastMessageAt',
            'lastMessagePreview', 'path', 'thumb_path', 'thumbPath', 'disk', 'sha256', 'original_name', 'originalName', 'workspace_id',
            'assigned_agent_id', 'visitor_id', 'token_hash', 'is_admin', 'role',
        ];
        $forbiddenText = ['sam.agent@company.example', 'Internal-Legal-Name', 'vera@visitor.example', '+1 555 0100', 'chat/attachments', 'screenshot.png', 'password'];

        foreach ($payloads as $label => $payload) {
            $this->assertNoIntegerIds($payload);

            foreach ($this->allKeys($payload) as $key) {
                $this->assertNotContains($key, $forbiddenKeys, "{$label} exposes {$key}");
            }

            foreach ($forbiddenText as $needle) {
                $this->assertStringNotContainsString($needle, (string) json_encode($payload), "{$label} leaks {$needle}");
            }
        }
    }

    public function test_the_staff_views_may_carry_ids_but_never_secrets(): void
    {
        $payload = $this->toPayload(ConversationStaffData::fromModel($this->fresh()));
        $json = (string) json_encode($payload);

        foreach (['password', 'token', 'secret', 'sam.agent@company.example', 'Internal-Legal-Name', 'workspace_id', 'visitor_id', 'assigned_agent_id'] as $needle) {
            $this->assertStringNotContainsString($needle, $json);
        }
    }

    // ---- Offer, rating, presence -------------------------------------------------------------------------------------

    public function test_the_offer_payload_is_exactly_chat_offered(): void
    {
        $this->conversation->forceFill(['status' => ConversationStatus::Queued, 'assigned_agent_id' => null])->save();
        $this->travelTo('2026-11-20 10:00:00');
        $offer = ConversationOffer::factory()->create(['conversation_id' => $this->conversation->id, 'user_id' => $this->agent->id, 'wave' => 2, 'expires_at' => now()->addSeconds(90)]);

        $payload = $this->toPayload(OfferData::fromModel($this->fresh(), $offer));

        $this->assertKeys(['v', 'conversation', 'category', 'visitor', 'preview', 'widget', 'wave', 'expiresAt', 'ttlSeconds'], $payload);
        $this->assertSame(90, $payload['ttlSeconds']);
        $this->assertSame(1, $payload['v']);
        $this->assertSame($this->conversation->ulid, $payload['conversation']);
        $this->assertSame(['slug' => 'billing', 'label' => 'Billing'], $payload['category']);
        $this->assertSame(['name' => 'Vera Visitor', 'verified' => true], $payload['visitor']);
        $this->assertSame('Where is my invoice?', $payload['preview']);
        $this->assertSame(['ulid' => $this->conversation->widget->ulid, 'name' => $this->conversation->widget->name], $payload['widget']);
        $this->assertSame(2, $payload['wave']);
        $this->assertSame($offer->expires_at->utc()->format('Y-m-d\TH:i:s.v\Z'), $payload['expiresAt']);
        $this->assertStringNotContainsString('vera@visitor.example', (string) json_encode($payload));
        $this->assertNoIntegerIds($payload);
    }

    public function test_the_offer_ttl_counts_down_from_the_moment_the_payload_is_built_and_never_goes_negative(): void
    {
        $this->travelTo('2026-11-20 10:00:00');
        $offer = ConversationOffer::factory()->create(['conversation_id' => $this->conversation->id, 'user_id' => $this->agent->id, 'expires_at' => now()->addSeconds(60)]);
        $conversation = $this->fresh();

        $this->assertSame(60, OfferData::fromModel($conversation, $offer)->ttlSeconds);

        $this->travelTo('2026-11-20 10:00:45');
        $this->assertSame(15, OfferData::fromModel($conversation, $offer)->ttlSeconds);
        $this->assertSame('2026-11-20T10:01:00.000Z', OfferData::fromModel($conversation, $offer)->expiresAt, 'the absolute time stays');

        $this->travelTo('2026-11-20 10:05:00');
        $this->assertSame(0, OfferData::fromModel($conversation, $offer)->ttlSeconds);
    }

    public function test_an_offer_for_an_anonymous_visitor_without_category_or_message(): void
    {
        $conversation = Conversation::factory()->create();
        $conversation->visitor->forceFill(['name' => null])->save();
        $offer = ConversationOffer::factory()->create(['conversation_id' => $conversation->id]);

        $payload = $this->toPayload(OfferData::fromModel(Conversation::query()->with(['category', 'visitor', 'widget'])->findOrFail($conversation->id), $offer));

        $this->assertNull($payload['category']);
        $this->assertNull($payload['preview']);
        $this->assertSame(['name' => null, 'verified' => false], $payload['visitor']);
    }

    public function test_a_rating_names_the_conversation_by_ulid(): void
    {
        $rating = Rating::factory()->create(['conversation_id' => $this->conversation->id, 'score' => 4, 'comment' => 'Quick and kind']);

        $payload = $this->toPayload(RatingData::fromModel($rating->fresh() ?? $rating));

        $this->assertKeys(['conversation', 'score', 'comment', 'createdAt'], $payload);
        $this->assertSame($this->conversation->ulid, $payload['conversation']);
        $this->assertSame(4, $payload['score']);
        $this->assertSame('Quick and kind', $payload['comment']);
        $this->assertNoIntegerIds($payload);
    }

    public function test_presence_payloads(): void
    {
        $presence = AgentPresence::factory()->away()->manual()->create(['user_id' => $this->agent->id]);

        $own = $this->toPayload(PresenceData::fromModel($presence->fresh() ?? $presence));
        $member = $this->toPayload(PresenceMemberData::fromModel($this->agent, PresenceStatus::Online));

        $this->assertKeys(['userId', 'status', 'isManual', 'lastSeenAt'], $own);
        $this->assertSame($this->agent->id, $own['userId']);
        $this->assertSame('away', $own['status']);
        $this->assertTrue($own['isManual']);
        $this->assertSame(['id' => $this->agent->id, 'name' => 'Sam', 'avatarUrl' => $this->avatarUrl(), 'status' => 'online'], $member);
    }

    public function test_small_reference_classes(): void
    {
        $this->assertSame(['slug' => 'billing', 'label' => 'Billing'], CategoryRefData::fromModel($this->category)->toArray());
        $this->assertSame(['id' => $this->agent->id, 'name' => 'Sam'], StaffAgentRefData::fromModel($this->agent)->toArray());
        $this->assertSame(['name' => 'Sam', 'avatarUrl' => $this->avatarUrl()], AgentRefData::fromModel($this->agent)->toArray());
    }

    public function test_enum_values_serialise_as_their_string_value(): void
    {
        $payload = $this->toPayload(ConversationPublicData::fromModel($this->fresh()));

        $this->assertSame(ConversationStatus::Active->value, $payload['status']);
        $this->assertSame(ConversationType::Live->value, $payload['type']);
        $this->assertSame(MessageType::Text->value, 'text');
        $this->assertSame(SenderType::Visitor->value, 'visitor');
    }
}
