<?php

namespace Tests\Feature\Chat;

use App\Data\Chat\AgentRefData;
use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\Events\ChatAssignedPayload;
use App\Data\Chat\Events\ChatClaimedPayload;
use App\Data\Chat\Events\ChatTakenPayload;
use App\Data\Chat\Events\ConversationClosedPayload;
use App\Data\Chat\Events\ConversationEndedPayload;
use App\Data\Chat\Events\ConversationRatedPayload;
use App\Data\Chat\Events\ConversationTransferredPayload;
use App\Data\Chat\Events\ConversationUpdatedPayload;
use App\Data\Chat\Events\MessageCreatedPayload;
use App\Data\Chat\Events\MessageDeliveredPayload;
use App\Data\Chat\Events\MessageSeenPayload;
use App\Data\Chat\Events\OfflineTicketCreatedPayload;
use App\Data\Chat\Events\PresenceChangedPayload;
use App\Data\Chat\Events\QueueUpdatedPayload;
use App\Data\Chat\Events\SessionRevokedPayload;
use App\Data\Chat\Events\UnreadUpdatedPayload;
use App\Data\Chat\MessageData;
use App\Data\Chat\OfferData;
use App\Data\Chat\StaffAgentRefData;
use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Spatie\LaravelData\Data;
use Tests\Support\FakeAttachmentUrls;
use Tests\TestCase;

/**
 * One test per realtime event of docs/contracts/realtime-events.md: the payload class serialises to exactly the documented
 * shape, always with `v: 1` first.
 */
class ChatEventPayloadsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->app->instance(AttachmentUrls::class, new FakeAttachmentUrls);
    }

    /**
     * @return array<string, mixed>
     */
    private function payload(Data $data): array
    {
        /** @var array<string, mixed> $payload */
        $payload = json_decode($data->toJson(), true, 512, JSON_THROW_ON_ERROR);

        return $payload;
    }

    public function test_every_payload_starts_with_the_version(): void
    {
        $conversation = Conversation::factory()->active()->create();
        $staff = ConversationStaffData::fromModel(Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id));

        $payloads = [
            new ChatTakenPayload('c', new StaffAgentRefData(1, 'A')),
            new ChatAssignedPayload('c'),
            new ConversationUpdatedPayload($staff),
            new UnreadUpdatedPayload('c', 2),
            new QueueUpdatedPayload(3),
            new SessionRevokedPayload(SessionRevokeReason::Deactivated),
            new PresenceChangedPayload(1, PresenceStatus::Away),
            new ChatClaimedPayload(new AgentRefData('A', null), '2026-11-20T10:00:00.000Z'),
            new MessageDeliveredPayload(4, SenderType::Visitor, '2026-11-20T10:00:00.000Z'),
            new MessageSeenPayload(4, SenderType::Visitor, '2026-11-20T10:00:00.000Z'),
            new ConversationEndedPayload(ConversationEndedBy::Visitor, true),
            new ConversationClosedPayload(ConversationCloseReason::Idle),
            new ConversationTransferredPayload,
            new OfflineTicketCreatedPayload($staff),
            new ConversationRatedPayload('c', 5),
        ];

        foreach ($payloads as $payload) {
            $array = $this->payload($payload);

            $this->assertSame('v', array_key_first($array), $payload::class);
            $this->assertSame(1, $array['v'], $payload::class);
        }
    }

    public function test_the_staff_channel_events(): void
    {
        $this->assertSame(
            ['v' => 1, 'conversation' => '01CONV', 'by' => ['id' => 7, 'name' => 'Sam']],
            $this->payload(new ChatTakenPayload('01CONV', new StaffAgentRefData(7, 'Sam'))),
        );
        $this->assertSame(['v' => 1, 'conversation' => '01CONV'], $this->payload(new ChatAssignedPayload('01CONV')));
        $this->assertSame(['v' => 1, 'conversation' => '01CONV', 'unseen' => 3], $this->payload(new UnreadUpdatedPayload('01CONV', 3)));
        $this->assertSame(['v' => 1, 'queued' => 2], $this->payload(new QueueUpdatedPayload(2)));
        $this->assertSame(['v' => 1, 'reason' => 'role_removed'], $this->payload(new SessionRevokedPayload(SessionRevokeReason::RoleRemoved)));
        $this->assertSame(['v' => 1, 'reason' => 'auth_revoked'], $this->payload(new SessionRevokedPayload(SessionRevokeReason::AuthRevoked)));
        $this->assertSame(['v' => 1, 'userId' => 7, 'status' => 'offline'], $this->payload(new PresenceChangedPayload(7, PresenceStatus::Offline)));
    }

    public function test_the_conversation_list_events_carry_the_staff_conversation(): void
    {
        $conversation = Conversation::factory()->offline()->create();
        $staff = ConversationStaffData::fromModel(Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id));

        foreach ([new ConversationUpdatedPayload($staff), new OfflineTicketCreatedPayload($staff)] as $payload) {
            $array = $this->payload($payload);

            $this->assertSame(['v', 'conversation'], array_keys($array));
            $this->assertSame($conversation->ulid, $array['conversation']['ulid']);
            $this->assertArrayHasKey('visitor', $array['conversation']);
            $this->assertArrayHasKey('unseenByAgent', $array['conversation']);
        }
    }

    public function test_the_offer_event_is_the_offer_data_class(): void
    {
        $conversation = Conversation::factory()->create();
        $offer = ConversationOffer::factory()->create(['conversation_id' => $conversation->id]);

        $array = $this->payload(OfferData::fromModel(Conversation::query()->with(['category', 'visitor', 'widget'])->findOrFail($conversation->id), $offer));

        $this->assertSame(['v', 'conversation', 'category', 'visitor', 'preview', 'widget', 'wave', 'expiresAt', 'ttlSeconds'], array_keys($array));
    }

    public function test_the_conversation_channel_events(): void
    {
        $this->assertSame(
            ['v' => 1, 'agent' => ['name' => 'Sam', 'avatarUrl' => null], 'claimedAt' => '2026-11-20T10:00:00.000Z'],
            $this->payload(new ChatClaimedPayload(new AgentRefData('Sam', null), '2026-11-20T10:00:00.000Z')),
        );
        $this->assertSame(
            ['v' => 1, 'upToSeq' => 9, 'by' => 'agent', 'at' => '2026-11-20T10:00:00.000Z'],
            $this->payload(new MessageSeenPayload(9, SenderType::Agent, '2026-11-20T10:00:00.000Z')),
        );
        $this->assertSame(
            ['v' => 1, 'upToSeq' => 9, 'by' => 'visitor', 'at' => '2026-11-20T10:00:00.000Z'],
            $this->payload(new MessageDeliveredPayload(9, SenderType::Visitor, '2026-11-20T10:00:00.000Z')),
        );
        $this->assertSame(['v' => 1, 'endedBy' => 'admin', 'ratingRequested' => true], $this->payload(new ConversationEndedPayload(ConversationEndedBy::Admin, true)));
        $this->assertSame(['v' => 1, 'reason' => 'timeout'], $this->payload(new ConversationClosedPayload(ConversationCloseReason::Timeout)));
        $this->assertSame(['v' => 1], $this->payload(new ConversationTransferredPayload));
    }

    public function test_message_created_wraps_the_visitor_safe_message(): void
    {
        $agent = User::factory()->create(['email' => 'agent@company.example']);
        $conversation = Conversation::factory()->active($agent)->create();
        $message = Message::factory()->for($conversation)->fromAgent($agent)->create();

        $array = $this->payload(new MessageCreatedPayload(MessageData::fromModel($message)));

        $this->assertSame(['v', 'message'], array_keys($array));
        $this->assertSame($message->ulid, $array['message']['ulid']);
        $this->assertArrayNotHasKey('id', $array['message']['sender'], 'the conversation channel is shared with the visitor');
        $this->assertStringNotContainsString('agent@company.example', (string) json_encode($array));
    }

    public function test_conversation_rated_carries_the_score_only(): void
    {
        $this->assertSame(['v' => 1, 'conversation' => '01CONV', 'score' => 5], $this->payload(new ConversationRatedPayload('01CONV', 5)));
    }
}
