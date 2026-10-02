<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Where a WhatsApp session is in its life (decision P6-D6, docs/contracts/whatsapp-data-p6.md):
 *
 * ```text
 * created      -> starting | failed
 * starting     -> qr | ready | disconnected | failed
 * qr           -> starting | ready | disconnected | failed
 * ready        -> starting | qr | disconnected | failed
 * disconnected -> starting | qr | ready | failed
 * failed       -> starting | disconnected
 * ```
 *
 * `created` is the entry state only (nothing ever goes back to it). The table says which moves are legal for the actions an administrator
 * triggers and flags an out-of-order webhook; OpenWA stays the source of truth, so a reconciliation (a webhook, a `GET /sessions/{id}`)
 * writes the status it reports through {@see self::fromOpenWa()} even when a delivery was missed, and only logs a move this table does
 * not know. The wire values of OpenWA differ from ours (`initializing` / `authenticating` -> `starting`, `qr_ready` -> `qr`,
 * `action_required` -> `failed`).
 */
#[TypeScript]
enum SessionStatus: string
{
    case Created = 'created';
    case Starting = 'starting';
    case Qr = 'qr';
    case Ready = 'ready';
    case Disconnected = 'disconnected';
    case Failed = 'failed';

    /**
     * The statuses this one may move to.
     *
     * @return list<self>
     */
    public function allowedTransitions(): array
    {
        return match ($this) {
            self::Created => [self::Starting, self::Failed],
            self::Starting => [self::Qr, self::Ready, self::Disconnected, self::Failed],
            self::Qr => [self::Starting, self::Ready, self::Disconnected, self::Failed],
            self::Ready => [self::Starting, self::Qr, self::Disconnected, self::Failed],
            self::Disconnected => [self::Starting, self::Qr, self::Ready, self::Failed],
            self::Failed => [self::Starting, self::Disconnected],
        };
    }

    public function canTransitionTo(self $to): bool
    {
        return in_array($to, $this->allowedTransitions(), true);
    }

    /** Connected to a phone: the only status in which messages can be sent and a hand-off number is worth showing. */
    public function isUsable(): bool
    {
        return $this === self::Ready;
    }

    /** An engine is running for the session (it is connecting, waiting for a scan, or connected). */
    public function isRunning(): bool
    {
        return in_array($this, [self::Starting, self::Qr, self::Ready], true);
    }

    /** `POST /sessions/{id}/start` makes sense. */
    public function canStart(): bool
    {
        return in_array($this, [self::Created, self::Disconnected, self::Failed], true);
    }

    /** `POST /sessions/{id}/stop` makes sense. */
    public function canStop(): bool
    {
        return $this->isRunning();
    }

    /**
     * Our status for the string OpenWA reports (`created | initializing | qr_ready | authenticating | ready | disconnected |
     * action_required | failed`, lower case). Our own names are accepted too. Null for anything else: a caller keeps the status it has.
     */
    public static function fromOpenWa(?string $status): ?self
    {
        return match (strtolower(trim((string) $status))) {
            'created' => self::Created,
            'initializing', 'authenticating', 'starting' => self::Starting,
            'qr_ready', 'qr' => self::Qr,
            'ready' => self::Ready,
            'disconnected' => self::Disconnected,
            'action_required', 'failed' => self::Failed,
            default => null,
        };
    }
}
