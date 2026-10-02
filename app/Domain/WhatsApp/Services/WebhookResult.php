<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\WhatsApp\Enums\WebhookOutcome;

/** What became of one webhook delivery: the outcome for the ledger and, when it is not a plain success, a short note for `error`. */
final readonly class WebhookResult
{
    public function __construct(
        public WebhookOutcome $outcome,
        public ?string $note = null,
    ) {}

    public static function processed(): self
    {
        return new self(WebhookOutcome::Processed);
    }

    public static function duplicate(): self
    {
        return new self(WebhookOutcome::Duplicate);
    }

    public static function ignored(string $why): self
    {
        return new self(WebhookOutcome::Ignored, $why);
    }
}
