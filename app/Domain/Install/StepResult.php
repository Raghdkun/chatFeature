<?php

namespace App\Domain\Install;

/**
 * Outcome of one install step: ok | failed(message) | needsInput(fields).
 */
final readonly class StepResult
{
    public const OK = 'ok';

    public const FAILED = 'failed';

    public const NEEDS_INPUT = 'needs_input';

    /**
     * @param  'ok'|'failed'|'needs_input'  $status
     * @param  list<string>  $fields  Wizard answers still missing (needs_input only).
     */
    private function __construct(
        public string $status,
        public ?string $message = null,
        public array $fields = [],
    ) {}

    public static function ok(?string $message = null): self
    {
        return new self(self::OK, $message);
    }

    public static function failed(string $message): self
    {
        return new self(self::FAILED, $message);
    }

    /**
     * @param  list<string>  $fields
     */
    public static function needsInput(array $fields, ?string $message = null): self
    {
        return new self(self::NEEDS_INPUT, $message ?? 'More information is needed: '.implode(', ', $fields), $fields);
    }

    public function isOk(): bool
    {
        return $this->status === self::OK;
    }
}
