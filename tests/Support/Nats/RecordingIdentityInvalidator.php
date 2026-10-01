<?php

namespace Tests\Support\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use Closure;

/**
 * In-memory IdentityInvalidator that records exactly which method was called with which id.
 */
final class RecordingIdentityInvalidator implements IdentityInvalidator
{
    /** @var list<array{string, string|null}> */
    public array $calls = [];

    /** @var (Closure(string, string|null): void)|null throw from here to simulate a failing handler */
    public ?Closure $beforeCall = null;

    public function flushForExternalId(string $externalId): void
    {
        $this->record('flushForExternalId', $externalId);
    }

    public function deactivateExternalId(string $externalId): void
    {
        $this->record('deactivateExternalId', $externalId);
    }

    public function flushAll(): void
    {
        $this->record('flushAll', null);
    }

    private function record(string $method, ?string $id): void
    {
        if ($this->beforeCall instanceof Closure) {
            ($this->beforeCall)($method, $id);
        }

        $this->calls[] = [$method, $id];
    }
}
