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
