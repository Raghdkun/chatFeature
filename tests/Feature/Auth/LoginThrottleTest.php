<?php

namespace Tests\Feature\Auth;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Sign-in is throttled three ways: per email + address (5/min), per address (30/min: one address spraying many emails)
 * and per email across every address (10/min: one account attacked from many). A throttled request never reaches the
 * portal.
 */
class LoginThrottleTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        // Portal mode: a refused sign-in is a quick HTTP 401 from the fake portal (a local password check is slow on purpose).
        $this->usePortalMode();
        $this->portal = PizzasysMock::make()->user('real@example.test', 'correct-horse-battery', 'agent')->fake();
    }

    private function attempt(string $email, string $ip = '203.0.113.9')
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $ip])->post(route('login.store'), ['email' => $email, 'password' => 'wrong-password']);
    }

    public function test_a_throttled_dashboard_form_goes_back_with_the_wait_instead_of_a_bare_429(): void
    {
        for ($i = 1; $i <= 30; $i++) {
            $this->attempt("user{$i}@example.test");
        }

        $throttled = $this->withHeaders(['X-Inertia' => 'true', 'X-Inertia-Version' => 'x'])->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])
            ->post(route('login.store'), ['email' => 'user31@example.test', 'password' => 'wrong-password']);

        $throttled->assertRedirect();
        $this->assertNotSame(429, $throttled->getStatusCode());
        $this->assertStringContainsString('Too many attempts. Try again in', json_encode(session()->all()) ?: '');
    }

    public function test_one_address_cannot_spray_unlimited_emails(): void
    {
        for ($i = 1; $i <= 30; $i++) {
            $this->attempt("user{$i}@example.test")->assertSessionHasErrors('email');
        }

        $this->attempt('user31@example.test')->assertTooManyRequests();
        $this->attempt('someone.else@example.test')->assertTooManyRequests();
        $this->attempt('user1@example.test', '203.0.113.10')->assertSessionHasErrors('email');
    }

    public function test_one_account_cannot_be_attacked_from_unlimited_addresses(): void
    {
        for ($i = 1; $i <= 10; $i++) {
            $this->attempt('victim@example.test', "203.0.113.{$i}")->assertSessionHasErrors('email');
        }

        $this->attempt('victim@example.test', '198.51.100.77')->assertTooManyRequests();
        $this->attempt('another@example.test', '198.51.100.77')->assertSessionHasErrors('email');
    }

    public function test_the_per_email_counter_ignores_case_and_surrounding_spaces(): void
    {
        $variants = ['victim@example.test', 'VICTIM@example.test', ' victim@example.test', 'Victim@Example.Test '];

        for ($i = 0; $i < 10; $i++) {
            $this->attempt($variants[$i % 4], '203.0.113.'.($i + 1));
        }

        $this->attempt(' ViCtIm@example.test', '198.51.100.1')->assertTooManyRequests();
    }

    public function test_the_original_per_person_limit_still_applies(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->attempt('person@example.test')->assertSessionHasErrors('email');
        }

        $this->attempt('person@example.test')->assertTooManyRequests();
    }

    public function test_requests_without_an_email_do_not_share_one_bucket_across_addresses(): void
    {
        for ($i = 1; $i <= 15; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => "203.0.113.{$i}"])
                ->post(route('login.store'), ['password' => 'x'])
                ->assertSessionHasErrors('email');
        }
    }

    public function test_the_limits_follow_the_configuration(): void
    {
        config(['chat.login_throttle' => ['per_email_and_ip' => 2, 'per_ip' => 3, 'per_email' => 50]]);

        $this->attempt('a@example.test');
        $this->attempt('b@example.test');
        $this->attempt('c@example.test');

        $this->attempt('d@example.test')->assertTooManyRequests();
    }

    public function test_a_legitimate_sign_in_is_not_affected_by_other_peoples_traffic(): void
    {
        for ($i = 1; $i <= 9; $i++) {
            $this->attempt("noise{$i}@example.test", '198.51.100.50');
        }

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.200'])
            ->post(route('login.store'), ['email' => 'real@example.test', 'password' => 'correct-horse-battery'])
            ->assertRedirect(route('dashboard', absolute: false));
    }

    public function test_a_throttled_request_never_reaches_the_portal(): void
    {
        for ($i = 1; $i <= 30; $i++) {
            $this->attempt("user{$i}@example.test");
        }
        $this->assertSame(30, $this->portal->calls('login'));

        $this->attempt('user31@example.test')->assertTooManyRequests();
        $this->assertSame(30, $this->portal->calls('login'), 'the 31st attempt was stopped before the portal');
    }
}
