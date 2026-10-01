<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Install\Support\PizzasysAnswers;
use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use Illuminate\Contracts\Container\Container;

/**
 * Step 4: default settings plus whatever other contexts registered under the `install.seeders` tag.
 *
 * The wizard's own answers (name, URL, locale, timezone, idle timeout, auth mode) always win while
 * the install is unfinished; every other default is only written when missing, so re-running is safe.
 */
final class SeedDefaultsStep implements InstallStep
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly Container $container,
    ) {}

    public function key(): string
    {
        return 'seed-defaults';
    }

    public function label(): string
    {
        return 'Write the default settings';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        $basics = $context->basics;
        $mode = AuthMode::tryFrom((string) $context->mode);

        if ($basics === null || $mode === null) {
            return StepResult::needsInput($basics === null ? ['basics'] : ['mode']);
        }

        $pizzasys = $mode === AuthMode::Pizzasys ? PizzasysAnswers::from($context->authEnvironments) : null;

        if ($pizzasys !== null) {
            $problem = $this->writeEnvironments($pizzasys);

            if ($problem !== null) {
                return $problem;
            }
        }

        $answers = [
            'app.name' => $basics['app_name'],
            'app.url' => $basics['app_url'],
            'app.locale' => $basics['locale'],
            'app.timezone' => $basics['timezone'],
            'chat.default_idle_timeout_minutes' => $basics['idle_timeout_minutes'],
            'auth.mode' => $mode->value,
            ...($pizzasys !== null ? [
                'auth.pizzasys.active_env' => $pizzasys->activeKey(),
                'auth.pizzasys.admin_permission' => $pizzasys->roles()->adminPermission,
                'auth.pizzasys.agent_permission' => $pizzasys->roles()->agentPermission,
                'auth.pizzasys.super_roles' => $pizzasys->roles()->superRoles,
                'auth.pizzasys.nats.enabled' => ($pizzasys->environment($pizzasys->activeKey())['nats_url'] ?? null) !== null,
            ] : []),
        ];

        foreach ($answers as $key => $value) {
            $this->settings->set($key, $value);
        }

        foreach ($this->settings->registry()->all() as $key => $definition) {
            if ($definition->seed && ! array_key_exists($key, $answers)) {
                $this->settings->seedMissing($key, $definition->defaultValue());
            }
        }

        foreach ($this->container->tagged('install.seeders') as $seeder) {
            if ($seeder instanceof SeedsDefaults) {
                $seeder->seed($context);
            }
        }

        return StepResult::ok();
    }

    /**
     * Mode 2: write `auth_environments` from the wizard answers (secrets decrypted from the install state and
     * re-encrypted by the model). The table mirrors the answers exactly, so a changed answer replaces the old row.
     */
    private function writeEnvironments(PizzasysAnswers $answers): ?StepResult
    {
        if (! $answers->isConfigured()) {
            return StepResult::needsInput(['pizzasys']);
        }

        foreach ($answers->environments() as $key => $environment) {
            $endpoint = $answers->endpoint($key);

            if ($endpoint === null) {
                return StepResult::failed("The stored service token of the {$key} environment cannot be read. Enter it again.");
            }

            AuthEnvironment::query()->updateOrCreate(['key' => $key], [
                'label' => $environment['label'],
                'base_url' => $environment['base_url'],
                'api_prefix' => $environment['api_prefix'],
                'service_name' => $environment['service_name'],
                'service_token' => $endpoint->serviceToken,
                'nats_url' => $environment['nats_url'],
                'nats_token' => $answers->natsToken($key),
                'verify_tls' => $environment['verify_tls'],
            ]);
        }

        AuthEnvironment::query()->whereNotIn('key', array_keys($answers->environments()))->delete();

        return null;
    }
}
