<?php

namespace Tests\Feature\Analytics;

use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

/**
 * Who may read what. The matrix: administrator, agent, another agent, an account without a chat role, a deactivated agent, a guest and a
 * visitor token, against every analytics endpoint. The agent's scope is enforced on the server: nothing a client sends can reach another row.
 */
class AnalyticsAuthorizationTest extends TestCase
{
    use ChatFixtures, InteractsWithAnalytics, RefreshDatabase;

    private const RANGE = ['from' => '2026-03-20', 'to' => '2026-03-27'];

    private const SCOPED = ['overview', 'timeseries', 'heatmap', 'ratings'];

    private const ADMIN_ONLY = ['breakdown', 'whatsapp', 'export'];

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics();
    }

    /**
     * @param  array<string, mixed>  $query
     */
    private function ask(string $endpoint, ?User $as, array $query = [], array $headers = []): TestResponse
    {
        $query += self::RANGE;
        $query += match ($endpoint) {
            'timeseries' => ['metric' => 'handled'],
            'breakdown' => ['by' => 'widget'],
            'export' => ['format' => 'csv'],
            default => [],
        };

        $request = $as === null ? $this : $this->actingAs($as, 'sanctum');

        return $request->getJson('/api/v1/analytics/'.$endpoint.'?'.http_build_query($query), $headers);
    }

    public function test_an_administrator_reads_everything(): void
    {
        foreach ([...self::SCOPED, ...self::ADMIN_ONLY] as $endpoint) {
            $this->ask($endpoint, $this->dataset->admin)->assertOk();
        }
    }

    public function test_an_agent_reads_the_scoped_endpoints_and_is_refused_the_admin_only_ones(): void
    {
        $agent = $this->dataset->agents[0];

        foreach (self::SCOPED as $endpoint) {
            $this->ask($endpoint, $agent)->assertOk();
        }

        foreach (self::ADMIN_ONLY as $endpoint) {
            $this->ask($endpoint, $agent)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
    }

    public function test_nobody_else_gets_anything(): void
    {
        $noRole = User::factory()->withoutChatAccess()->create();
        $inactive = User::factory()->agent()->inactive()->create();
        $token = $this->visitorSession($this->dataset->widgets[0]);

        // Guests first: `actingAs` stays in force for the rest of a test.
        foreach ([...self::SCOPED, ...self::ADMIN_ONLY] as $endpoint) {
            $this->ask($endpoint, null)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
            // A visitor's bearer token is not a staff credential: Sanctum does not know it.
            $this->ask($endpoint, null, [], $this->bearer($token))->assertUnauthorized();
        }

        foreach ([...self::SCOPED, ...self::ADMIN_ONLY] as $endpoint) {
            $this->ask($endpoint, $noRole)->assertForbidden();
            $this->ask($endpoint, $inactive)->assertStatus(401);
        }
    }

    public function test_an_agent_cannot_reach_another_agents_numbers(): void
    {
        [$ann, $bob] = [$this->dataset->agents[0], $this->dataset->agents[1]];

        $this->ask('overview', $ann, ['agent' => $bob->id])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->ask('timeseries', $ann, ['agent' => $bob->id])->assertForbidden();
        $this->ask('heatmap', $ann, ['agent' => $bob->id])->assertForbidden();
        $this->ask('ratings', $ann, ['agent' => $bob->id])->assertForbidden();

        // Asking for their own id is fine, and is the same answer as not asking.
        $own = $this->ask('overview', $ann, ['agent' => $ann->id])->assertOk()->json('data.current');
        $this->assertSame($this->ask('overview', $ann)->json('data.current'), $own);
    }

    public function test_the_numbers_an_agent_gets_are_theirs_whatever_the_client_sends(): void
    {
        [$ann, $bob] = [$this->dataset->agents[0], $this->dataset->agents[1]];
        $annsHandled = $this->expectedRow(self::RANGE['from'], self::RANGE['to'], 'agent', (string) $ann->id)['handled'];
        $bobsHandled = $this->expectedRow(self::RANGE['from'], self::RANGE['to'], 'agent', (string) $bob->id)['handled'];
        $this->assertNotSame($annsHandled, $bobsHandled, 'the dataset must tell the two agents apart');

        foreach (['', '&scope=admin', '&role=admin', '&dimension=total', '&key=0', '&agent[]='.$bob->id] as $extra) {
            $response = $this->actingAs($ann, 'sanctum')->getJson('/api/v1/analytics/overview?from=2026-03-20&to=2026-03-27'.$extra);

            if ($extra === '&agent[]='.$bob->id) {
                $response->assertStatus(422);

                continue;
            }

            $this->assertSame($annsHandled, $response->assertOk()->json('data.current.handled'), $extra);
        }
    }

    public function test_an_agent_cannot_slice_their_numbers_by_widget_or_topic(): void
    {
        $agent = $this->dataset->agents[0];

        $this->ask('overview', $agent, ['widget' => $this->dataset->widgets[0]->ulid])->assertStatus(422);
        $this->ask('overview', $agent, ['category' => $this->dataset->categories[0]->ulid])->assertStatus(422);
    }

    public function test_an_agent_never_receives_a_whatsapp_number_or_a_colleagues_name(): void
    {
        $agent = $this->dataset->agents[0];
        $others = collect($this->dataset->agents)->reject(fn (User $other) => $other->is($agent))->map->name->all();

        foreach (self::SCOPED as $endpoint) {
            $json = (string) $this->ask($endpoint, $agent)->assertOk()->getContent();

            $this->assertStringNotContainsString('wa_', $json, $endpoint);
            $this->assertStringNotContainsString('linkedShare', $json, $endpoint);
            $this->assertStringNotContainsString('inbound', $json, $endpoint);

            foreach ($others as $name) {
                $this->assertStringNotContainsString($name, $json, "{$endpoint} names a colleague");
            }
        }

        $this->assertFalse($this->ask('overview', $agent)->json('data.scope.whatsapp'));
        $this->assertTrue($this->ask('overview', $this->dataset->admin)->json('data.scope.whatsapp'));
    }

    public function test_an_administrator_may_apply_one_filter_but_not_two(): void
    {
        $widget = $this->dataset->widgets[0]->ulid;
        $category = $this->dataset->categories[0]->ulid;

        $this->ask('overview', $this->dataset->admin, ['widget' => $widget])->assertOk();
        $this->ask('overview', $this->dataset->admin, ['widget' => $widget, 'category' => $category])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->ask('overview', $this->dataset->admin, ['widget' => $widget, 'agent' => $this->dataset->agents[0]->id])->assertStatus(422);
    }

    public function test_the_agent_metrics_exclude_what_no_single_agent_causes(): void
    {
        $agent = $this->dataset->agents[0];

        $this->ask('timeseries', $agent, ['metric' => 'handled,frt_avg,rating_avg'])->assertOk();
        $this->ask('timeseries', $agent, ['metric' => 'started'])->assertStatus(422);
        $this->ask('timeseries', $agent, ['metric' => 'handled,missed'])->assertStatus(422);
        $this->ask('timeseries', $this->dataset->admin, ['metric' => 'started', 'agent' => $agent->id])->assertStatus(422);
        $this->ask('heatmap', $agent, ['metric' => 'started'])->assertStatus(422);
    }

    public function test_an_agents_heatmap_and_timeseries_are_their_own(): void
    {
        $agent = $this->dataset->agents[0];
        $expected = $this->expectedRow(self::RANGE['from'], self::RANGE['to'], 'agent', (string) $agent->id);
        $series = $this->ask('timeseries', $agent, ['metric' => 'handled', 'interval' => 'day'])->json('data.series.0.points');

        $this->assertSame($expected['handled'], (int) array_sum(array_column($series, 'value')));
    }

    public function test_the_export_is_audited_and_an_agents_attempt_is_not_a_download(): void
    {
        $this->ask('export', $this->dataset->agents[0])->assertForbidden();
        $this->assertSame(0, AuditLog::query()->where('action', 'analytics.exported')->count());

        $this->ask('export', $this->dataset->admin)->assertOk();

        $log = AuditLog::query()->where('action', 'analytics.exported')->sole();
        $this->assertSame($this->dataset->admin->id, $log->actor_id);
        $this->assertEquals(['format' => 'csv', 'from' => '2026-03-20', 'to' => '2026-03-27', 'dimension' => 'total'], $log->changes);   // MySQL JSON reorders keys
    }
}
