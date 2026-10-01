<?php

namespace App\Domain\Install;

/** What InstallRunner reports back for one executed step. */
final readonly class StepReport
{
    public function __construct(
        public string $key,
        public StepResult $result,
        public ?string $next,
        public bool $installed,
    ) {}
}
