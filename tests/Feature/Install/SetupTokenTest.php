<?php

namespace Tests\Feature\Install;

use Inertia\Testing\AssertableInertia as Assert;

class SetupTokenTest extends InstallTestCase
{
    public function test_a_token_is_required_outside_the_local_environment(): void
    {
        $this->get(route('setup.index'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('setup/index')
                ->where('setup.step', 'welcome')
                ->where('setup.needsToken', true)
                ->where('setup.tokenVerified', false));

        $this->post(route('setup.mode'), ['mode' => 'fortify'])->assertRedirect(route('setup.index'));
        $this->assertNull($this->install->mode());

        $this->getJson(route('setup.state'))->assertForbidden();
        $this->postJson(route('setup.run', 'run-migrations'))->assertForbidden();
    }

    public function test_a_wrong_token_is_rejected(): void
    {
        $this->post(route('setup.token'), ['token' => 'not-the-token'])
            ->assertSessionHasErrors('token');

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.tokenVerified', false));
    }

    public function test_the_correct_token_unlocks_the_wizard(): void
    {
        $this->post(route('setup.token'), ['token' => self::TOKEN])
            ->assertSessionHasNoErrors()
            ->assertRedirect(route('setup.index'));

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.tokenVerified', true)
            ->where('setup.step', 'mode'));
    }

    public function test_the_token_is_skipped_in_the_local_environment(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('setup.needsToken', false)
            ->where('setup.tokenVerified', true)
            ->where('setup.step', 'mode'));

        // CSRF protection is switched off in the testing environment only; it applies once we pretend to be local.
        $this->withSession(['_token' => 'csrf'])
            ->post(route('setup.mode'), ['mode' => 'fortify', '_token' => 'csrf'])
            ->assertRedirect(route('setup.index'));
        $this->assertSame('fortify', $this->install->mode());
    }

    // ---- APP_ENV=local is not enough: the request has to come from this machine -----------------------------------

    public function test_a_forgotten_app_env_does_not_open_the_wizard_to_the_internet(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])
            ->get(route('setup.index'))
            ->assertInertia(fn (Assert $page) => $page
                ->where('setup.needsToken', true)
                ->where('setup.tokenVerified', false)
                ->where('setup.step', 'welcome'));

        // CSRF protection applies once we pretend to be local.
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->withSession(['_token' => 'csrf'])
            ->post(route('setup.mode'), ['mode' => 'fortify', '_token' => 'csrf'])
            ->assertRedirect(route('setup.index'));
        $this->assertNull($this->install->mode(), 'nothing was stored');
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->getJson(route('setup.state'))->assertForbidden();
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->withSession(['_token' => 'csrf'])
            ->postJson(route('setup.run', 'run-migrations'), ['_token' => 'csrf'])
            ->assertForbidden();
    }

    public function test_the_token_still_unlocks_a_local_environment_request_from_elsewhere(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->withSession(['_token' => 'csrf'])
            ->post(route('setup.token'), ['token' => self::TOKEN, '_token' => 'csrf'])
            ->assertRedirect(route('setup.index'));

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->getJson(route('setup.state'))->assertOk();
    }

    public function test_a_local_environment_without_a_configured_token_fails_closed_for_remote_requests(): void
    {
        $this->app->detectEnvironment(fn () => 'local');
        config(['install.setup_token' => null]);

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->withSession(['_token' => 'csrf'])
            ->post(route('setup.token'), ['token' => 'anything', '_token' => 'csrf'])
            ->assertSessionHasErrors('token');
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->getJson(route('setup.state'))->assertForbidden();

        // ... while a request from this machine keeps working without one (server variables stick to the test client)
        $this->withServerVariables(['REMOTE_ADDR' => '127.0.0.1'])->getJson(route('setup.state'))->assertOk();
    }

    public function test_a_proxy_in_front_of_a_local_environment_does_not_count_as_this_machine(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        // the reverse proxy runs on the same host: the TCP peer is 127.0.0.1, but the request is somebody else's
        foreach (['X-Forwarded-For' => '198.51.100.7', 'X-Forwarded-Host' => 'chat.example.com', 'X-Forwarded-Proto' => 'https', 'Forwarded' => 'for=198.51.100.7', 'X-Real-IP' => '198.51.100.7'] as $header => $value) {
            $this->flushHeaders();
            $this->withHeader($header, $value)->getJson(route('setup.state'))->assertForbidden();
        }
        $this->flushHeaders();

        $this->getJson(route('setup.state'))->assertOk();
    }

    public function test_loopback_in_every_spelling_counts_as_this_machine(): void
    {
        $this->app->detectEnvironment(fn () => 'local');

        foreach (['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'] as $address) {
            $this->withServerVariables(['REMOTE_ADDR' => $address])->getJson(route('setup.state'))->assertOk();
        }

        foreach (['10.0.0.1', '172.17.0.1', '192.168.1.5', '::2', 'fe80::1', '127.0.0.1.evil', ''] as $address) {
            $this->withServerVariables(['REMOTE_ADDR' => $address])->getJson(route('setup.state'))->assertForbidden();
        }
    }

    public function test_loopback_is_not_enough_outside_the_local_environment(): void
    {
        foreach (['production', 'staging', 'testing'] as $environment) {
            $this->app->detectEnvironment(fn () => $environment);

            $this->withServerVariables(['REMOTE_ADDR' => '127.0.0.1'])->getJson(route('setup.state'))->assertForbidden();
        }
    }

    public function test_the_server_failing_closed_when_no_token_is_configured(): void
    {
        config(['install.setup_token' => null]);

        $this->post(route('setup.token'), ['token' => 'anything'])->assertSessionHasErrors('token');
        $this->post(route('setup.token'), ['token' => ''])->assertSessionHasErrors('token');

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page->where('setup.tokenVerified', false));
    }

    public function test_the_token_endpoint_is_throttled_to_five_attempts_a_minute(): void
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->post(route('setup.token'), ['token' => 'wrong-'.$attempt])->assertSessionHasErrors('token');
        }

        $this->post(route('setup.token'), ['token' => self::TOKEN])->assertTooManyRequests();
    }

    public function test_the_token_is_never_rendered_in_a_response_or_flashed_back(): void
    {
        $responses = [
            $this->get(route('setup.index')),
            $this->post(route('setup.token'), ['token' => 'wrong-token-value-xyz']),
            $this->get(route('setup.index')),
            $this->post(route('setup.token'), ['token' => self::TOKEN]),
            $this->get(route('setup.index')),
            $this->getJson(route('setup.state')),
        ];

        foreach ($responses as $response) {
            $this->assertStringNotContainsString(self::TOKEN, $response->getContent() ?: '');
            $this->assertStringNotContainsString('wrong-token-value-xyz', $response->getContent() ?: '');
            $this->assertStringNotContainsString(self::TOKEN, json_encode($response->headers->all()) ?: '');
        }

        $this->assertNull(session()->getOldInput('token'));
    }

    public function test_environment_details_are_withheld_until_the_token_is_verified(): void
    {
        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->has('setup.environment.checks', fn (Assert $checks) => $checks
                ->each(fn (Assert $check) => $check->missing('message')->etc())));

        $this->verifySetupToken();

        $messages = collect($this->getJson(route('setup.state'))->json('setup.environment.checks'))->pluck('message')->filter();
        $this->assertNotEmpty($messages);
    }
}
