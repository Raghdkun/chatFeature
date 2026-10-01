<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallState;
use Tests\TestCase;

/**
 * Base for tests that exercise the not-installed application: the install state points at a
 * throwaway directory, the setup token is known and the (absent) frontend build is faked.
 */
abstract class InstallTestCase extends TestCase
{
    public const TOKEN = 'test-setup-token-1234';

    protected InstallState $install;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config([
            'inertia.testing.ensure_pages_exist' => false,
            'install.setup_token' => self::TOKEN,
        ]);

        $this->install = InstallState::fake(installed: false);
    }

    protected function verifySetupToken(): void
    {
        $this->post(route('setup.token'), ['token' => self::TOKEN])->assertRedirect(route('setup.index'));
    }

    protected function chooseFortify(): void
    {
        $this->post(route('setup.mode'), ['mode' => 'fortify'])->assertRedirect(route('setup.index'));
    }

    protected function postAdmin(string $email = 'owner@example.test', string $password = 'a-long-test-password'): void
    {
        $this->post(route('setup.admin'), [
            'name' => 'Owner',
            'email' => $email,
            'password' => $password,
            'password_confirmation' => $password,
        ])->assertRedirect(route('setup.index'));
    }

    protected function postBasics(): void
    {
        $this->post(route('setup.basics'), [
            'app_name' => 'Acme Chat',
            'app_url' => 'https://chat.acme.test',
            'locale' => 'en',
            'timezone' => 'Europe/Berlin',
            'idle_timeout_minutes' => 90,
        ])->assertRedirect(route('setup.index'));
    }

    /** Everything the wizard asks before the run screen. */
    protected function answerWizard(): void
    {
        $this->verifySetupToken();
        $this->chooseFortify();
        $this->postAdmin();
        $this->postBasics();
    }
}
