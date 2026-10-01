<?php

namespace App\Domain\Install\Steps;

use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Install\Support\PizzasysAnswers;

/**
 * Step 2 (mode `pizzasys`): the portal environments, the role mapping and the verified portal administrator.
 *
 * The wizard collects these through `POST /setup/pizzasys`, `/setup/pizzasys/test` and `/setup/portal-admin` (the
 * live `token-verify` probe and the portal-admin login happen there, tokens encrypted in the install state); this step
 * checks that the answers are complete and readable before anything is written to the database.
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
        $answers = PizzasysAnswers::from($context->authEnvironments);

        if (! $answers->isConfigured()) {
            return StepResult::needsInput(['pizzasys']);
        }

        foreach (array_keys($answers->environments()) as $key) {
            if ($answers->endpoint($key) === null) {
                return StepResult::failed("The stored service token of the {$key} environment cannot be read. Enter it again.");
            }
        }

        if ($answers->portalAdmin() === null) {
            return StepResult::needsInput(['portal-admin']);
        }

        if ($answers->portalAdmin()['environment'] !== $answers->activeKey()) {
            return StepResult::needsInput(['portal-admin'], 'The portal administrator was verified against another environment. Sign in again.');
        }

        return StepResult::ok();
    }
}
