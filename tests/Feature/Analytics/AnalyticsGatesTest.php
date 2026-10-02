<?php

namespace Tests\Feature\Analytics;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/** The `analytics.*` gates, asked directly (no HTTP): the abilities behind the routes' own checks. */
class AnalyticsGatesTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array<string, array{0: string, 1: array<string, bool>}>
     */
    public static function matrix(): array
    {
        //                                  view   view-all whatsapp export
        return [
            'admin' => ['admin', ['view' => true, 'view-all' => true, 'whatsapp' => true, 'export' => true]],
            'agent' => ['agent', ['view' => true, 'view-all' => false, 'whatsapp' => false, 'export' => false]],
            'no chat role' => ['none', ['view' => false, 'view-all' => false, 'whatsapp' => false, 'export' => false]],
            'deactivated admin' => ['inactive-admin', ['view' => false, 'view-all' => false, 'whatsapp' => false, 'export' => false]],
            'deactivated agent' => ['inactive-agent', ['view' => false, 'view-all' => false, 'whatsapp' => false, 'export' => false]],
        ];
    }

    private function user(string $kind): User
    {
        return match ($kind) {
            'admin' => User::factory()->admin()->create(),
            'agent' => User::factory()->agent()->create(),
            'inactive-admin' => User::factory()->admin()->inactive()->create(),
            'inactive-agent' => User::factory()->agent()->inactive()->create(),
            default => User::factory()->withoutChatAccess()->create(),
        };
    }

    /**
     * @param  array<string, bool>  $expected
     */
    #[DataProvider('matrix')]
    public function test_each_role_gets_exactly_its_abilities(string $kind, array $expected): void
    {
        $user = $this->user($kind);

        foreach ($expected as $ability => $allowed) {
            $this->assertSame($allowed, Gate::forUser($user)->allows("analytics.{$ability}"), "{$kind} analytics.{$ability}");
        }
    }

    public function test_a_guest_is_allowed_nothing(): void
    {
        foreach (['view', 'view-all', 'whatsapp', 'export'] as $ability) {
            $this->assertFalse(Gate::allows("analytics.{$ability}"), $ability);
        }
    }
}
