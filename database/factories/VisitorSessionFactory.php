<?php

namespace Database\Factories;

use App\Domain\Visitors\VisitorTokenService;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * Sessions made here have a random token nobody knows; use `withToken()` (or `VisitorTokenService::issue()`) when a test
 * needs to authenticate with it.
 *
 * @extends Factory<VisitorSession>
 */
class VisitorSessionFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'visitor_id' => Visitor::factory(),
            'widget_id' => fn (array $attributes): int => (int) Visitor::query()->whereKey($attributes['visitor_id'])->value('widget_id'),
            'token_hash' => VisitorTokenService::hash(VisitorTokenService::PREFIX.Str::random(VisitorTokenService::RANDOM_LENGTH)),
            'expires_at' => now()->addDays(30),
            'revoked_at' => null,
            'last_used_at' => null,
            'page_url' => 'https://customer.test/pricing',
            'page_title' => 'Pricing',
            'referrer' => null,
            'user_agent' => 'Mozilla/5.0 (Macintosh) TestBrowser/1.0',
            'locale' => 'en',
        ];
    }

    /** The session belongs to this plaintext token (`vt_...`). */
    public function withToken(string $plaintext): static
    {
        return $this->state(fn (): array => ['token_hash' => VisitorTokenService::hash($plaintext)]);
    }

    public function expired(): static
    {
        return $this->state(fn (): array => ['expires_at' => now()->subMinute()]);
    }

    public function revoked(): static
    {
        return $this->state(fn (): array => ['revoked_at' => now()->subMinute()]);
    }
}
