<?php

namespace Tests\Feature\Install;

use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Domain\Settings\SettingDefinition;
use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingsRegistry;
use App\Domain\Settings\SettingType;
use App\Models\Setting;

class SeedDefaultsHookTest extends InstallTestCase
{
    public function test_other_contexts_can_seed_through_the_tagged_hook_and_register_their_own_defaults(): void
    {
        $seeder = new class implements SeedsDefaults
        {
            public int $calls = 0;

            public ?string $mode = null;

            public function seed(InstallContext $context): void
            {
                $this->calls++;
                $this->mode = $context->mode;
            }
        };
        $this->app->instance('test.seeder', $seeder);
        $this->app->tag('test.seeder', 'install.seeders');

        app(SettingsRegistry::class)->define(
            new SettingDefinition('chat.greeting', SettingGroup::Chat, SettingType::String, 'Hi there!', ['string']),
            new SettingDefinition('chat.not_seeded', SettingGroup::Chat, SettingType::String, 'x', ['string'], seed: false),
        );

        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('status', 'ok');
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame(2, $seeder->calls, 'the hook is called on every (idempotent) run');
        $this->assertSame('fortify', $seeder->mode);
        $this->assertSame('"Hi there!"', Setting::query()->where('key', 'chat.greeting')->value('value'));
        $this->assertDatabaseMissing('settings', ['key' => 'chat.not_seeded']);
    }

    public function test_re_seeding_never_clobbers_values_changed_in_the_meantime(): void
    {
        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'));
        $this->postJson(route('setup.run', 'seed-defaults'));

        Setting::query()->where('key', 'auth.allow_registration')->update(['value' => 'true']);

        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame('true', Setting::query()->where('key', 'auth.allow_registration')->value('value'));
    }
}
