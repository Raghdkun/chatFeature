<?php

namespace App\Auth\Support;

/** Health of an auth driver (e.g. portal reachability in mode 2). Fortify is always ok. */
final readonly class HealthReport
{
    /**
     * @param  'ok'|'degraded'|'down'  $status
     * @param  array<string, mixed>  $details
     */
    public function __construct(
        public string $status,
        public ?string $message = null,
        public array $details = [],
    ) {}

    public static function ok(?string $message = null): self
    {
        return new self('ok', $message);
    }

    public function isOk(): bool
    {
        return $this->status === 'ok';
    }
}
