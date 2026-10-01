<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Identity\IdentityFailure;
use App\Domain\Widgets\Identity\IdentityTokenVerifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The verifier the application hands out: the configured lifetime and the application cache behind `jti` single use.
 */
class IdentityVerifierWiringTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    public function test_the_container_verifier_uses_the_configured_maximum_lifetime(): void
    {
        config(['chat.identity.max_lifetime_seconds' => 60]);
        $widget = $this->enabledWidget();
        $widget->forceFill(['identity_secret_encrypted' => Crypt::encryptString('s3cret-s3cret-s3cret')])->save();
        $verifier = app(IdentityTokenVerifier::class);

        $ok = $this->mintIdentityToken(['iss' => $widget->public_key, 'exp' => time() + 50], 's3cret-s3cret-s3cret');
        $tooLong = $this->mintIdentityToken(['iss' => $widget->public_key, 'exp' => time() + 200], 's3cret-s3cret-s3cret');

        $this->assertTrue($verifier->verifyForWidget($ok, $widget->refresh())->isValid());
        $this->assertSame(IdentityFailure::ExpiryTooFar, $verifier->verifyForWidget($tooLong, $widget)->failure);
    }

    public function test_the_default_lifetime_is_five_minutes_and_jti_is_single_use_through_the_application_cache(): void
    {
        $widget = $this->enabledWidget();
        $widget->forceFill(['identity_secret_encrypted' => Crypt::encryptString('s3cret-s3cret-s3cret')])->save();
        $verifier = app(IdentityTokenVerifier::class);

        $this->assertSame(300, config('chat.identity.max_lifetime_seconds'));
        $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'exp' => time() + 290, 'jti' => 'one-time-1'], 's3cret-s3cret-s3cret');

        $this->assertTrue($verifier->verifyForWidget($token, $widget->refresh())->isValid());
        // A new resolution of the verifier (another request) still sees it: the memory is the cache, not the object.
        $this->app->forgetInstance(IdentityTokenVerifier::class);
        $this->assertSame(IdentityFailure::Replayed, app(IdentityTokenVerifier::class)->verifyForWidget($token, $widget)->failure);
    }
}
