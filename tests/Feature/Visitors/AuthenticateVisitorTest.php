<?php

namespace Tests\Feature\Visitors;

use App\Domain\Visitors\VisitorTokenService;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The `visitor` middleware alias on a throwaway route in the bearer-only `widget` group (the real chat routes arrive with 4A).
 */
class AuthenticateVisitorTest extends TestCase
{
    use RefreshDatabase;

    private const URL = '/api/v1/public/_visitor-probe';

    protected function setUp(): void
    {
        parent::setUp();

        Route::middleware(['widget', 'visitor'])->get(self::URL, function (Request $request): array {
            $session = $request->attributes->get('visitor_session');
            $visitor = $request->attributes->get('visitor');

            return [
                'session' => $session instanceof VisitorSession ? $session->ulid : null,
                'visitor' => $visitor instanceof Visitor ? $visitor->ulid : null,
                'user' => $request->user()?->getAuthIdentifier(),
            ];
        });
    }

    /**
     * @return array{error: array{code: string, message: string}}
     */
    private function unauthenticated(): array
    {
        return ['error' => ['code' => 'unauthenticated', 'message' => 'Authentication is required.']];
    }

    public function test_a_valid_token_authenticates_and_exposes_the_session_and_visitor(): void
    {
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());

        $this->withToken($issued->plaintext)->getJson(self::URL)
            ->assertOk()
            ->assertExactJson([
                'session' => $issued->session->ulid,
                'visitor' => $issued->session->visitor->ulid,
                'user' => null,
            ]);
    }

    public function test_a_request_without_a_token_is_unauthenticated(): void
    {
        $this->getJson(self::URL)->assertStatus(401)->assertExactJson($this->unauthenticated());
    }

    /**
     * @return iterable<string, array{array<string, string>}>
     */
    public static function badAuthorizationHeaders(): iterable
    {
        yield 'garbage' => [['Authorization' => 'Bearer not-a-token']];
        yield 'wrong prefix' => [['Authorization' => 'Bearer wk_'.str_repeat('a', 40)]];
        yield 'unknown token' => [['Authorization' => 'Bearer vt_'.str_repeat('a', 40)]];
        yield 'basic scheme' => [['Authorization' => 'Basic '.base64_encode('vt_'.str_repeat('a', 40))]];
        yield 'empty bearer' => [['Authorization' => 'Bearer ']];
    }

    /**
     * @param  array<string, string>  $headers
     */
    #[DataProvider('badAuthorizationHeaders')]
    public function test_every_kind_of_bad_token_gets_the_same_unauthenticated_envelope(array $headers): void
    {
        app(VisitorTokenService::class)->issue(Visitor::factory()->create());

        $this->withHeaders($headers)->getJson(self::URL)->assertStatus(401)->assertExactJson($this->unauthenticated());
    }

    public function test_a_token_in_the_query_string_or_a_cookie_is_not_accepted(): void
    {
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());

        $this->getJson(self::URL.'?token='.$issued->plaintext)->assertStatus(401);
        $this->getJson(self::URL.'?access_token='.$issued->plaintext)->assertStatus(401);
        $this->withUnencryptedCookie('visitor_token', $issued->plaintext)->getJson(self::URL)->assertStatus(401);
    }

    public function test_a_revoked_session_answers_session_revoked(): void
    {
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        app(VisitorTokenService::class)->revoke($issued->session);

        $this->withToken($issued->plaintext)->getJson(self::URL)
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'session_revoked')
            ->assertJsonMissingPath('error.details');
    }

    public function test_an_expired_session_answers_session_revoked(): void
    {
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create(), [], now()->subSecond());

        $this->withToken($issued->plaintext)->getJson(self::URL)->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_using_the_token_records_the_visit_at_most_once_a_minute(): void
    {
        $this->travelTo('2026-11-20 10:00:00');
        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());

        $this->travelTo('2026-11-20 10:00:20');
        $this->withToken($issued->plaintext)->getJson(self::URL)->assertOk();
        $this->assertSame('2026-11-20 10:00:00', $issued->session->fresh()?->last_used_at?->format('Y-m-d H:i:s'));

        $this->travelTo('2026-11-20 10:05:00');
        $this->withToken($issued->plaintext)->getJson(self::URL)->assertOk();
        $this->assertSame('2026-11-20 10:05:00', $issued->session->fresh()?->last_used_at?->format('Y-m-d H:i:s'));
    }

    public function test_the_alias_is_registered_and_the_group_stays_cookie_free(): void
    {
        $this->assertArrayHasKey('visitor', app('router')->getMiddleware());

        $issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        $response = $this->withToken($issued->plaintext)->getJson(self::URL);

        $this->assertCount(0, $response->headers->getCookies());
    }
}
