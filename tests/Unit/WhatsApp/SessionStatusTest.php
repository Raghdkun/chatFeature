<?php

namespace Tests\Unit\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The session state machine (decision P6-D6, docs/contracts/whatsapp-data-p6.md). The whole table is spelled out here on purpose:
 * changing a transition must be a conscious edit of this test.
 */
class SessionStatusTest extends TestCase
{
    private const TABLE = [
        'created' => ['starting', 'failed'],
        'starting' => ['qr', 'ready', 'disconnected', 'failed'],
        'qr' => ['starting', 'ready', 'disconnected', 'failed'],
        'ready' => ['starting', 'qr', 'disconnected', 'failed'],
        'disconnected' => ['starting', 'qr', 'ready', 'failed'],
        'failed' => ['starting', 'disconnected'],
    ];

    /**
     * @return iterable<string, array{string}>
     */
    public static function statuses(): iterable
    {
        foreach (SessionStatus::cases() as $status) {
            yield $status->value => [$status->value];
        }
    }

    #[DataProvider('statuses')]
    public function test_allowed_transitions_match_the_documented_table(string $from): void
    {
        $allowed = array_map(static fn (SessionStatus $status): string => $status->value, SessionStatus::from($from)->allowedTransitions());

        $this->assertSame(self::TABLE[$from], $allowed);
    }

    #[DataProvider('statuses')]
    public function test_can_transition_to_agrees_with_the_table_for_every_pair(string $from): void
    {
        $from = SessionStatus::from($from);

        foreach (SessionStatus::cases() as $to) {
            $this->assertSame(in_array($to->value, self::TABLE[$from->value], true), $from->canTransitionTo($to), "{$from->value} -> {$to->value}");
        }
    }

    public function test_a_status_never_transitions_to_itself_and_nothing_goes_back_to_created(): void
    {
        foreach (SessionStatus::cases() as $status) {
            $this->assertFalse($status->canTransitionTo($status), $status->value);
            $this->assertFalse($status->canTransitionTo(SessionStatus::Created), $status->value);
        }
    }

    public function test_only_a_ready_session_is_usable(): void
    {
        foreach (SessionStatus::cases() as $status) {
            $this->assertSame($status === SessionStatus::Ready, $status->isUsable(), $status->value);
        }
    }

    public function test_running_start_and_stop_follow_the_engine(): void
    {
        $this->assertSame(['starting', 'qr', 'ready'], array_values(array_map(
            static fn (SessionStatus $s): string => $s->value,
            array_filter(SessionStatus::cases(), static fn (SessionStatus $s): bool => $s->isRunning()),
        )));

        foreach (SessionStatus::cases() as $status) {
            $this->assertSame($status->isRunning(), $status->canStop(), $status->value);
            $this->assertSame(! $status->isRunning(), $status->canStart(), $status->value);
        }
    }

    /**
     * @return iterable<string, array{?string, ?SessionStatus}>
     */
    public static function openWaStatuses(): iterable
    {
        yield 'created' => ['created', SessionStatus::Created];
        yield 'initializing' => ['initializing', SessionStatus::Starting];
        yield 'authenticating' => ['authenticating', SessionStatus::Starting];
        yield 'qr_ready' => ['qr_ready', SessionStatus::Qr];
        yield 'ready' => ['ready', SessionStatus::Ready];
        yield 'disconnected' => ['disconnected', SessionStatus::Disconnected];
        yield 'action_required' => ['action_required', SessionStatus::Failed];
        yield 'failed' => ['failed', SessionStatus::Failed];
        yield 'upper case and padding' => [' READY ', SessionStatus::Ready];
        yield 'our own names' => ['qr', SessionStatus::Qr];
        yield 'unknown' => ['hibernating', null];
        yield 'empty' => ['', null];
        yield 'null' => [null, null];
    }

    #[DataProvider('openWaStatuses')]
    public function test_openwa_wire_values_map_to_ours(?string $wire, ?SessionStatus $expected): void
    {
        $this->assertSame($expected, SessionStatus::fromOpenWa($wire));
    }
}
