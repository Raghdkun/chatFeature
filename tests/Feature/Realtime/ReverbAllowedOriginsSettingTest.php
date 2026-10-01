<?php

namespace Tests\Feature\Realtime;

use App\Providers\RealtimeServiceProvider;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\Support\InstallStateFake;
use Tests\TestCase;

/**
 * The Reverb server process adds the application URL the setup wizard saved (a database setting) to the origins from the environment.
 */
class ReverbAllowedOriginsSettingTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_reverb_server_learns_the_url_the_wizard_saved(): void
    {
        InstallStateFake::make(installed: true);
        settings()->set('app.url', 'https://chat.acme.test');
        config(['reverb.apps.apps.0.allowed_origins' => ['127.0.0.1']]);

        (new RealtimeServiceProvider($this->app))->allowSavedAppHost();

        $this->assertSame(['127.0.0.1', 'chat.acme.test'], config('reverb.apps.apps.0.allowed_origins'));
    }

    public function test_before_the_install_the_saved_url_is_not_even_looked_up(): void
    {
        InstallStateFake::make(installed: false);
        config(['reverb.apps.apps.0.allowed_origins' => ['127.0.0.1']]);

        (new RealtimeServiceProvider($this->app))->allowSavedAppHost();

        $this->assertSame(['127.0.0.1'], config('reverb.apps.apps.0.allowed_origins'));
    }

    public function test_an_unreadable_setting_leaves_the_origins_alone(): void
    {
        InstallStateFake::make(installed: true);
        config(['reverb.apps.apps.0.allowed_origins' => ['127.0.0.1']]);
        Schema::drop('settings');

        (new RealtimeServiceProvider($this->app))->allowSavedAppHost();

        $this->assertSame(['127.0.0.1'], config('reverb.apps.apps.0.allowed_origins'));
    }
}
