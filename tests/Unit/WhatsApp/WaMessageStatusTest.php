<?php

namespace Tests\Unit\WhatsApp;

use App\Domain\WhatsApp\Enums\WaMessageStatus;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Delivery acks arrive late, twice and out of order: an outbound message only ever moves forward. */
class WaMessageStatusTest extends TestCase
{
    private const TABLE = [
        'pending' => ['sent', 'delivered', 'read', 'failed'],
        'sent' => ['delivered', 'read', 'failed'],
        'delivered' => ['read'],
        'read' => [],
        'failed' => [],
        'received' => [],
    ];

    /**
     * @return iterable<string, array{string}>
     */
    public static function statuses(): iterable
    {
        foreach (WaMessageStatus::cases() as $status) {
            yield $status->value => [$status->value];
        }
    }

    #[DataProvider('statuses')]
    public function test_allowed_transitions_match_the_documented_table(string $from): void
    {
        $allowed = array_map(static fn (WaMessageStatus $status): string => $status->value, WaMessageStatus::from($from)->allowedTransitions());

        $this->assertSame(self::TABLE[$from], $allowed);
        $this->assertSame(self::TABLE[$from] === [], WaMessageStatus::from($from)->isFinal());
    }

    public function test_a_status_never_advances_to_itself(): void
    {
        foreach (WaMessageStatus::cases() as $status) {
            $this->assertFalse($status->canAdvanceTo($status), $status->value);
        }
    }

    public function test_advance_takes_a_step_forward_and_ignores_the_rest(): void
    {
        $this->assertSame(WaMessageStatus::Delivered, WaMessageStatus::Sent->advance(WaMessageStatus::Delivered));
        $this->assertSame(WaMessageStatus::Read, WaMessageStatus::Sent->advance(WaMessageStatus::Read), 'an ack may skip a step');
        $this->assertSame(WaMessageStatus::Read, WaMessageStatus::Read->advance(WaMessageStatus::Delivered), 'a late ack never moves back');
        $this->assertSame(WaMessageStatus::Delivered, WaMessageStatus::Delivered->advance(WaMessageStatus::Failed), 'a delivered message cannot fail');
        $this->assertSame(WaMessageStatus::Failed, WaMessageStatus::Pending->advance(WaMessageStatus::Failed));
        $this->assertSame(WaMessageStatus::Failed, WaMessageStatus::Failed->advance(WaMessageStatus::Sent), 'failed is final');
        $this->assertSame(WaMessageStatus::Received, WaMessageStatus::Received->advance(WaMessageStatus::Read));
    }

    /**
     * @return iterable<string, array{?string, ?WaMessageStatus}>
     */
    public static function openWaStatuses(): iterable
    {
        yield 'pending' => ['pending', WaMessageStatus::Pending];
        yield 'sent' => ['sent', WaMessageStatus::Sent];
        yield 'delivered' => ['delivered', WaMessageStatus::Delivered];
        yield 'read' => ['read', WaMessageStatus::Read];
        yield 'played counts as read' => ['played', WaMessageStatus::Read];
        yield 'failed' => ['failed', WaMessageStatus::Failed];
        yield 'case' => [' Delivered', WaMessageStatus::Delivered];
        yield 'unknown' => ['revoked', null];
        yield 'null' => [null, null];
    }

    #[DataProvider('openWaStatuses')]
    public function test_the_canonical_status_string_of_an_ack_maps_to_ours(?string $wire, ?WaMessageStatus $expected): void
    {
        $this->assertSame($expected, WaMessageStatus::fromOpenWa($wire));
    }

    public function test_the_legacy_integer_ack_maps_to_ours(): void
    {
        $this->assertSame(WaMessageStatus::Failed, WaMessageStatus::fromAck(-1));
        $this->assertSame(WaMessageStatus::Pending, WaMessageStatus::fromAck(0));
        $this->assertSame(WaMessageStatus::Sent, WaMessageStatus::fromAck(1));
        $this->assertSame(WaMessageStatus::Delivered, WaMessageStatus::fromAck(2));
        $this->assertSame(WaMessageStatus::Read, WaMessageStatus::fromAck(3));
        $this->assertSame(WaMessageStatus::Read, WaMessageStatus::fromAck(4));
        $this->assertNull(WaMessageStatus::fromAck(9));
    }
}
