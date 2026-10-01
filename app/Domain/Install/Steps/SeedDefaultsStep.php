<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Settings\SettingsRepository;
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

        $answers = [
            'app.name' => $basics['app_name'],
            'app.url' => $basics['app_url'],
            'app.locale' => $basics['locale'],
            'app.timezone' => $basics['timezone'],
            'chat.default_idle_timeout_minutes' => $basics['idle_timeout_minutes'],
            'auth.mode' => $mode->value,
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
}
