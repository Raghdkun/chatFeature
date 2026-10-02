<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Delivery state of a recorded message. Outbound messages only move forward as OpenWA's `message.ack` / `message.failed` webhooks
 * arrive (in any order, and more than once):
 *
 * ```text
 * pending -> sent | delivered | read | failed        sent      -> delivered | read | failed
 * delivered -> read                                   read, failed, received: final
 * ```
 *
 * `received` is the status of every inbound message. `failed` is final and a message that was delivered can no longer fail.
 */
#[TypeScript]
enum WaMessageStatus: string
{
    case Pending = 'pending';
    case Sent = 'sent';
    case Delivered = 'delivered';
    case Read = 'read';
    case Failed = 'failed';
    case Received = 'received';

    /**
     * The statuses an outbound message may move to from this one.
     *
     * @return list<self>
     */
    public function allowedTransitions(): array
    {
        return match ($this) {
            self::Pending => [self::Sent, self::Delivered, self::Read, self::Failed],
            self::Sent => [self::Delivered, self::Read, self::Failed],
            self::Delivered => [self::Read],
            self::Read, self::Failed, self::Received => [],
        };
    }

    public function canAdvanceTo(self $to): bool
    {
        return in_array($to, $this->allowedTransitions(), true);
    }

    public function isFinal(): bool
    {
        return $this->allowedTransitions() === [];
    }

    /** The status to store when `$incoming` arrives for a message that is `$this`: the incoming one only when it is a step forward. */
    public function advance(self $incoming): self
    {
        return $this->canAdvanceTo($incoming) ? $incoming : $this;
    }

    /** OpenWA's canonical `status` string of an ack (`pending | sent | delivered | read | failed`); null for anything else. */
    public static function fromOpenWa(?string $status): ?self
    {
        return match (strtolower(trim((string) $status))) {
            'pending' => self::Pending,
            'sent' => self::Sent,
            'delivered' => self::Delivered,
            'read', 'played' => self::Read,
            'failed' => self::Failed,
            default => null,
        };
    }

    /** The deprecated integer `ack` of OpenWA: -1 failed, 0 pending, 1 sent, 2 delivered, 3 read, 4 played. */
    public static function fromAck(int $ack): ?self
    {
        return match ($ack) {
            -1 => self::Failed,
            0 => self::Pending,
            1 => self::Sent,
            2 => self::Delivered,
            3, 4 => self::Read,
            default => null,
        };
    }
}
