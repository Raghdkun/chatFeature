<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Support\AuthResult;
use App\Auth\Support\SessionContext;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * Live check against the local throwaway pizzasys harness (../chatFeature.harness, `run.sh start`). Skipped unless
 * `PIZZASYS_HARNESS=1`; the portal address, service credential and the test users' password come from the environment
 * (`set -a; source <harness>/secrets.local.env; set +a`), never from the repository.
 *
 *   PIZZASYS_HARNESS=1 php artisan test --group=harness
 */
#[Group('harness')]
class PizzasysHarnessTest extends TestCase
{
    use RefreshDatabase;

    private string $password;

    protected function setUp(): void
    {
        parent::setUp();

        if (getenv('PIZZASYS_HARNESS') !== '1') {
            $this->markTestSkipped('Set PIZZASYS_HARNESS=1 (and source the harness secrets) to run against the local pizzasys harness.');
        }

        $base = (string) getenv('PIZZASYS_BASE_URL');
        $service = (string) getenv('PIZZASYS_SERVICE_NAME');
        $token = (string) getenv('PIZZASYS_SERVICE_TOKEN');
        $this->password = (string) getenv('TEST_USER_PASSWORD');

        $this->assertNotSame('', $base.$service.$token.$this->password, 'the harness environment is not loaded');

        Http::swap(new Factory);

        settings()->set('auth.mode', 'pizzasys');
        AuthEnvironment::factory()->production()->create([
            'base_url' => $base,
            'service_name' => $service,
            'service_token' => $token,
        ]);
    }

    private function driver(): AuthDriver
    {
        return app(AuthDriver::class);
    }

    private function attempt(string $email, ?string $password = null): AuthResult
    {
        return $this->driver()->attempt(Request::create('/login', 'POST', ['email' => $email, 'password' => $password ?? $this->password]));
    }

    public function test_the_service_credential_probe_passes(): void
    {
        $environment = AuthEnvironment::query()->sole();

        $result = app(TestPortalConnection::class)($environment->endpoint(), null, null);

        $this->assertTrue($result->ok, (string) $result->failureSummary());
        $this->assertSame(['reachable', 'service_credential', 'latency', 'nats'], array_map(fn ($check) => $check->key->value, $result->checks));
    }

    public function test_every_test_user_maps_to_the_expected_roles(): void
    {
        $expected = [
            'admin@test.local' => [AuthOutcome::Ok, true, true],       // super-admin role, no chat.* permission
            'chatadmin@test.local' => [AuthOutcome::Ok, true, true],   // chat.admin permission
            'agent@test.local' => [AuthOutcome::Ok, false, true],      // chat.agent permission
            'roleagent@test.local' => [AuthOutcome::Ok, false, true],  // chat.agent through a role
            'norole@test.local' => [AuthOutcome::NoChatAccess, false, false],
            'storeuser@test.local' => [AuthOutcome::NoChatAccess, false, false], // store-scoped role only: not global
        ];

        foreach ($expected as $email => [$outcome, $admin, $agent]) {
            $result = $this->attempt($email);

            $this->assertSame($outcome, $result->outcome, $email);

            if ($outcome === AuthOutcome::Ok) {
                $this->assertSame($admin, $result->user->is_admin, $email.' is_admin');
                $this->assertSame($agent, $result->user->is_agent, $email.' is_agent');
                $this->assertSame('pizzasys', $result->user->auth_source);
            }
        }
    }

    public function test_wrong_password_and_unknown_account_are_invalid(): void
    {
        $this->assertSame(AuthOutcome::Invalid, $this->attempt('agent@test.local', 'definitely-wrong')->outcome);
        $this->assertSame(AuthOutcome::Invalid, $this->attempt('nobody@test.local')->outcome);
    }

    public function test_a_session_is_revalidated_and_revoked_when_the_token_is_revoked_upstream(): void
    {
        $result = $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => $this->password], 'harness');
        $this->assertTrue($result->isOk());
        $session = ExternalSession::query()->sole();
        $context = new SessionContext(null, '127.0.0.1', 'phpunit', null, $session->sanctum_token_id);

        $this->assertSame(SessionVerdict::Fresh, $this->driver()->validateSession($result->user, $context), 'verified at login, answered from the cache');

        $this->travel(2)->minutes(); // our cache expires; the portal is real, so only OUR clock moves
        $this->assertSame(SessionVerdict::Revalidated, $this->driver()->validateSession($result->user, $context));

        // the token is killed upstream (logout of exactly that token)
        $environment = AuthEnvironment::query()->sole();
        Http::acceptJson()->withToken((string) $session->token)->post($environment->base_url.'/api/v1/auth/logout')->throw();

        $this->travel(2)->minutes();
        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($result->user, $context));
        $this->assertNotNull($session->fresh()->revoked_at);
        $this->assertNull($session->fresh()->token);
    }

    public function test_a_wrong_service_token_fails_closed_for_logins_and_degrades_sessions(): void
    {
        $login = $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => $this->password], 'harness');
        $session = ExternalSession::query()->sole();
        $context = new SessionContext(null, '127.0.0.1', 'phpunit', null, $session->sanctum_token_id);

        $environment = AuthEnvironment::query()->sole();
        $environment->service_token = 'definitely-not-the-service-token';
        $environment->save();

        $this->assertSame(AuthOutcome::Unavailable, $this->attempt('agent@test.local')->outcome, 'new sign-ins fail closed');

        $this->travel(2)->minutes();
        $this->assertSame(SessionVerdict::Revalidated, $this->driver()->validateSession($login->user, $context), 'existing sessions keep working through /auth/me');
        $this->assertSame('degraded', $this->driver()->health()->status);
        $this->assertTrue($this->driver()->health()->details['service_credential_rejected']);
    }
}
