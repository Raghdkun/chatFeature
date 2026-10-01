<?php

namespace App\Domain\Install\Steps;

use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;

/**
 * Step 2 (mode `pizzasys`): domains, service client, live `token-verify` probe, verified portal-admin login.
 *
 * P2 placeholder: registered so the step order is fixed, but it always fails with a clear message.
 * P2 replaces this class in place (same key, same position in config/install.php).
 */
final class ConfigurePizzasysStep implements InstallStep
{
    public function key(): string
    {
        return 'configure-pizzasys';
    }

    public function label(): string
    {
        return 'Connect the pizzasys portal';
    }

    /**
     * @return list<string>
     */
    public function modes(): array
    {
        return ['pizzasys'];
    }

    public function run(InstallContext $context): StepResult
    {
        return StepResult::failed('pizzasys authentication is available in P2 and is not part of this release.');
    }
}
