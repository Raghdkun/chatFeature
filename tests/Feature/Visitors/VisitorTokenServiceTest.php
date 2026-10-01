<?php

namespace Tests\Feature\Visitors;

use App\Domain\Visitors\VisitorTokenService;
use App\Models\Conversation;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class VisitorTokenServiceTest extends TestCase
{
    use RefreshDatabase;

    private VisitorTokenService $tokens;

    protected function setUp(): void
    {
        parent::setUp();

        $this->tokens = app(VisitorTokenService::class);
    }

    public function test_a_token_is_vt_plus_forty_url_safe_characters(): void
    {
        $issued = $this->tokens->issue(Visitor::factory()->create());

        $this->assertMatchesRegularExpression('/^vt_[A-Za-z0-9]{40}$/D', $issued->plaintext);
        $this->assertTrue(VisitorTokenService::looksLikeToken($issued->plaintext));
        $this->assertCount(50, array_unique(array_map(fn (): string => VisitorTokenService::generate(), range(1, 50))));
    }

    public function test_only_the_sha256_of_the_token_is_stored(): void
    {
        $issued = $this->tokens->issue(Visitor::factory()->create());

        $this->assertSame(hash('sha256', $issued->plaintext), $issued->session->token_hash);
        $this->assertSame(64, strlen($issued->session->token_hash));
        $this->assertSame($issued->session->token_hash, VisitorTokenService::hash($issued->plaintext));

        foreach (DB::table('visitor_sessions')->get() as $row) {
            $this->assertStringNotContainsString($issued->plaintext, (string) json_encode($row));
        }
    }

    public function test_the_session_is_bound_to_the_visitor_and_their_widget(): void
    {
        $visitor = Visitor::factory()->create();

        $session = $this->tokens->issue($visitor, [
            'page_url' => 'https://customer.test/pricing',
            'page_title' => 'Pricing',
            'referrer' => 'https://search.test/?q=chat',
            'user_agent' => 'TestBrowser/1.0',
            'locale' => 'ar',
        ])->session->fresh();

        $this->assertInstanceOf(VisitorSession::class, $session);
        $this->assertSame($visitor->id, $session->visitor_id);
        $this->assertSame($visitor->widget_id, $session->widget_id);
        $this->assertSame('https://customer.test/pricing', $session->page_url);
        $this->assertSame('Pricing', $session->page_title);
        $this->assertSame('https://search.test/?q=chat', $session->referrer);
        $this->assertSame('TestBrowser/1.0', $session->user_agent);
        $this->assertSame('ar', $session->locale);
        $this->assertNull($session->revoked_at);
        $this->assertTrue($session->isActive());
    }

    public function test_page_context_is_bounded(): void
    {
        $session = $this->tokens->issue(Visitor::factory()->create(), [
            'page_url' => 'https://customer.test/'.str_repeat('a', 5000),
            'page_title' => str_repeat('t', 1000),
            'user_agent' => str_repeat('u', 1000),
            'locale' => str_repeat('x', 40),
            'referrer' => '',
        ])->session->fresh();

        $this->assertInstanceOf(VisitorSession::class, $session);
        $this->assertSame(2048, mb_strlen((string) $session->page_url));
        $this->assertSame(255, mb_strlen((string) $session->page_title));
        $this->assertSame(255, mb_strlen((string) $session->user_agent));
        $this->assertSame(12, mb_strlen((string) $session->locale));
        $this->assertNull($session->referrer);
    }

    public function test_the_session_lives_for_the_configured_number_of_days(): void
    {
        $this->travelTo('2026-11-20 10:00:00');

        $default = $this->tokens->issue(Visitor::factory()->create())->session;
        $this->assertSame('2026-12-20 10:00:00', $default->expires_at->format('Y-m-d H:i:s'));

        settings()->set('chat.visitor_session_ttl_days', 7);
        $short = $this->tokens->issue(Visitor::factory()->create())->session;
        $this->assertSame('2026-11-27 10:00:00', $short->expires_at->format('Y-m-d H:i:s'));

        $explicit = $this->tokens->issue(Visitor::factory()->create(), [], now()->addHour())->session;
        $this->assertSame('2026-11-20 11:00:00', $explicit->expires_at->format('Y-m-d H:i:s'));
    }

    public function test_a_valid_token_resolves_to_its_session(): void
    {
        $issued = $this->tokens->issue(Visitor::factory()->create());

        $this->assertTrue($this->tokens->find($issued->plaintext)?->is($issued->session));
        $this->assertTrue($this->tokens->resolve($issued->plaintext)?->is($issued->session));
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function garbage(): iterable
    {
        yield 'empty' => [''];
        yield 'no prefix' => [str_repeat('a', 43)];
        yield 'wrong prefix' => ['wk_'.str_repeat('a', 40)];
        yield 'upper-case prefix' => ['VT_'.str_repeat('a', 40)];
        yield 'too short' => ['vt_'.str_repeat('a', 39)];
        yield 'too long' => ['vt_'.str_repeat('a', 41)];
        yield 'bad characters' => ['vt_'.str_repeat('a', 39).'!'];
        yield 'url-unsafe' => ['vt_'.str_repeat('a', 38).'-_'];
        yield 'whitespace' => [' vt_'.str_repeat('a', 40)];
        yield 'trailing newline' => ['vt_'.str_repeat('a', 40)."\n"];
        yield 'sql' => ["vt_' OR '1'='1"];
        yield 'huge' => ['vt_'.str_repeat('a', 100_000)];
    }

    #[DataProvider('garbage')]
    public function test_anything_that_is_not_a_token_resolves_to_nothing(string $candidate): void
    {
        VisitorSession::factory()->create();

        $this->assertNull($this->tokens->find($candidate));
        $this->assertNull($this->tokens->resolve($candidate));
    }

    public function test_an_unknown_but_well_formed_token_resolves_to_nothing(): void
    {
        $this->tokens->issue(Visitor::factory()->create());

        $this->assertNull($this->tokens->find(VisitorTokenService::generate()));
    }

    public function test_a_token_with_changed_case_is_not_the_same_token(): void
    {
        $issued = $this->tokens->issue(Visitor::factory()->create());
        $mangled = 'vt_'.strtoupper(substr($issued->plaintext, 3));

        $this->assertNotSame($issued->plaintext, $mangled);
        $this->assertNull($this->tokens->find($mangled));
    }

    public function test_a_stored_hash_that_only_matches_case_insensitively_is_refused(): void
    {
        // MySQL compares strings case-insensitively; the exact (hash_equals) comparison must still reject a near miss.
        $plaintext = VisitorTokenService::generate();
        $session = VisitorSession::factory()->create();
        DB::table('visitor_sessions')->where('id', $session->id)->update(['token_hash' => strtoupper(VisitorTokenService::hash($plaintext))]);

        $this->assertNull($this->tokens->find($plaintext));
    }

    public function test_a_revoked_or_expired_session_is_found_but_not_resolved(): void
    {
        $revoked = $this->tokens->issue(Visitor::factory()->create());
        $this->tokens->revoke($revoked->session);
        $expired = $this->tokens->issue(Visitor::factory()->create(), [], now()->subMinute());

        $this->assertNotNull($this->tokens->find($revoked->plaintext));
        $this->assertNull($this->tokens->resolve($revoked->plaintext));
        $this->assertNotNull($this->tokens->find($expired->plaintext));
        $this->assertNull($this->tokens->resolve($expired->plaintext));
        $this->assertTrue($this->tokens->find($revoked->plaintext)?->isRevoked());
        $this->assertTrue($this->tokens->find($expired->plaintext)?->isExpired());
    }

    public function test_a_session_expires_exactly_when_its_time_is_up(): void
    {
        $this->travelTo('2026-11-20 10:00:00');
        $issued = $this->tokens->issue(Visitor::factory()->create(), [], now()->addMinutes(5));

        $this->travelTo('2026-11-20 10:04:59');
        $this->assertNotNull($this->tokens->resolve($issued->plaintext));

        $this->travelTo('2026-11-20 10:05:01');
        $this->assertNull($this->tokens->resolve($issued->plaintext));
    }

    public function test_revoking_is_idempotent_and_keeps_the_first_revocation_time(): void
    {
        $issued = $this->tokens->issue(Visitor::factory()->create());

        $this->travelTo('2026-11-20 10:00:00');
        $this->tokens->revoke($issued->session);
        $first = $issued->session->fresh()?->revoked_at;

        $this->travelTo('2026-11-20 12:00:00');
        $this->tokens->revoke($issued->session->fresh() ?? $issued->session);

        $this->assertNotNull($first);
        $this->assertTrue($first->equalTo($issued->session->fresh()?->revoked_at));
    }

    public function test_revoking_all_sessions_of_a_visitor_leaves_other_visitors_alone(): void
    {
        $visitor = Visitor::factory()->create();
        $a = $this->tokens->issue($visitor);
        $b = $this->tokens->issue($visitor);
        $other = $this->tokens->issue(Visitor::factory()->create());

        $this->assertSame(2, $this->tokens->revokeAllFor($visitor));
        $this->assertSame(0, $this->tokens->revokeAllFor($visitor));

        $this->assertNull($this->tokens->resolve($a->plaintext));
        $this->assertNull($this->tokens->resolve($b->plaintext));
        $this->assertNotNull($this->tokens->resolve($other->plaintext));
    }

    public function test_touching_is_throttled_and_also_marks_the_visitor_as_seen(): void
    {
        $this->travelTo('2026-11-20 10:00:00');
        $visitor = Visitor::factory()->create(['last_seen_at' => now()->subDay()]);
        $session = $this->tokens->issue($visitor)->session;

        $this->travelTo('2026-11-20 10:00:30');
        $this->tokens->touch($session);
        $this->assertSame('2026-11-20 10:00:00', $session->fresh()?->last_used_at?->format('Y-m-d H:i:s'), 'inside the throttle window nothing is written');
        $this->assertSame('2026-11-19 10:00:00', $visitor->fresh()?->last_seen_at?->format('Y-m-d H:i:s'));

        $this->travelTo('2026-11-20 10:02:00');
        $this->tokens->touch($session);
        $this->assertSame('2026-11-20 10:02:00', $session->fresh()?->last_used_at?->format('Y-m-d H:i:s'));
        $this->assertSame('2026-11-20 10:02:00', $visitor->fresh()?->last_seen_at?->format('Y-m-d H:i:s'));
    }

    public function test_touching_a_session_that_was_never_used_records_the_first_use(): void
    {
        $session = VisitorSession::factory()->create(['last_used_at' => null]);

        $this->tokens->touch($session);

        $this->assertNotNull($session->fresh()?->last_used_at);
    }

    public function test_a_session_owns_only_its_own_conversations(): void
    {
        $conversation = Conversation::factory()->create();
        $session = $conversation->visitorSession;
        $otherSession = VisitorSession::factory()->create();
        $sameVisitorOtherSession = VisitorSession::factory()->create(['visitor_id' => $conversation->visitor_id]);

        $this->assertInstanceOf(VisitorSession::class, $session);
        $this->assertTrue($session->owns($conversation));
        $this->assertFalse($otherSession->owns($conversation));
        $this->assertFalse($sameVisitorOtherSession->owns($conversation), 'a conversation is bound to the session that opened it');
        $this->assertFalse($session->owns(Conversation::factory()->create()));
    }

    public function test_the_token_hash_is_never_serialised(): void
    {
        $session = VisitorSession::factory()->create();

        $this->assertArrayNotHasKey('token_hash', $session->toArray());
    }

    public function test_the_active_scope_matches_the_model_rules(): void
    {
        $active = VisitorSession::factory()->create();
        VisitorSession::factory()->expired()->create();
        VisitorSession::factory()->revoked()->create();

        $this->assertSame([$active->id], VisitorSession::query()->active()->pluck('id')->all());
    }
}
