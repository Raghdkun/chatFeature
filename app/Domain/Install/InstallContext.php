<?php

namespace App\Domain\Install;

use Closure;

/**
 * The validated wizard answers (mode, admin credentials, auth environments, app basics) and the
 * InstallState handle, handed to every step.
 *
 * @phpstan-import-type State from InstallState
 */
final readonly class InstallContext
{
    /**
     * @param  array{name: string, email: string, password_hash: string|null}|null  $admin
     * @param  array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}|null  $basics
     * @param  array<string, mixed>  $authEnvironments  Mode 2 (P2): production/testing portal settings.
     * @param  (Closure(string): void)|null  $reporter  Progress sink (CLI output).
     */
    public function __construct(
        public InstallState $state,
        public ?string $mode,
        public ?array $admin,
        public ?array $basics,
        public array $authEnvironments = [],
        public ?Closure $reporter = null,
    ) {}

    /**
     * @param  (Closure(string): void)|null  $reporter
     */
    public static function fromState(InstallState $state, ?Closure $reporter = null): self
    {
        $data = $state->read();

        return new self(
            state: $state,
            mode: $data['mode'],
            admin: $data['admin'],
            basics: $data['basics'],
            authEnvironments: $data['auth_environments'],
            reporter: $reporter,
        );
    }

    public function report(string $line): void
    {
        if ($this->reporter !== null) {
            ($this->reporter)($line);
        }
    }
}
