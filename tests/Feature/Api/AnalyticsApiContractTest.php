<?php

namespace Tests\Feature\Api;

use App\Models\User;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\AssertsOpenApi;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

/**
 * The analytics API against the committed OpenAPI file ({@see AssertsOpenApi}): real answers for an administrator and for an agent, and the
 * documented refusals, validate against the schemas generated from the Data classes.
 */
class AnalyticsApiContractTest extends TestCase
{
    use AssertsOpenApi, InteractsWithAnalytics, RefreshDatabase;

    private const RANGE = ['from' => '2026-03-20', 'to' => '2026-03-27'];

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics(perDay: 4);
    }

    /**
     * @param  array<string, mixed>  $query
     */
    private function ask(User $as, string $endpoint, array $query = [], string $path = ''): TestResponse
    {
        $this->app['auth']->forgetGuards();
        $response = $this->flushHeaders()->actingAs($as, 'sanctum')->getJson('/api/v1/analytics/'.$endpoint.'?'.http_build_query($query + self::RANGE));
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'GET', '/api/v1/analytics/'.($path ?: $endpoint));

        return $response;
    }

    public function test_an_administrators_answers_match_the_reference(): void
    {
        $admin = $this->dataset->admin;

        $this->ask($admin, 'overview', ['compare' => 1])->assertOk();
        $this->ask($admin, 'overview', ['widget' => $this->dataset->widgets[0]->ulid])->assertOk();
        $this->ask($admin, 'timeseries', ['metric' => 'started,handled,wait_avg,rating_avg', 'interval' => 'week'])->assertOk();
        $this->ask($admin, 'breakdown', ['by' => 'agent'])->assertOk();
        $this->ask($admin, 'breakdown', ['by' => 'category'])->assertOk();
        $this->ask($admin, 'heatmap', ['tz' => 'Europe/Berlin'])->assertOk();
        $this->ask($admin, 'ratings')->assertOk();
        $this->ask($admin, 'whatsapp', ['compare' => 1, 'interval' => 'day'])->assertOk();
        $this->ask($admin, 'export', ['format' => 'csv'])->assertOk();
    }

    public function test_an_agents_answers_and_the_refusals_match_the_reference(): void
    {
        $agent = $this->dataset->agents[0];

        $this->ask($agent, 'overview', ['compare' => 1])->assertOk()->assertJsonPath('data.scope.role', 'agent');
        $this->ask($agent, 'timeseries', ['metric' => 'handled,frt_avg'])->assertOk();
        $this->ask($agent, 'heatmap')->assertOk()->assertJsonPath('data.metric', 'claimed');
        $this->ask($agent, 'ratings')->assertOk()->assertJsonPath('data.recent', []);

        $this->ask($agent, 'overview', ['agent' => $this->dataset->agents[1]->id])->assertForbidden();
        $this->ask($agent, 'overview', ['widget' => $this->dataset->widgets[0]->ulid])->assertStatus(422);
        $this->ask($agent, 'breakdown', ['by' => 'agent'])->assertForbidden();
        $this->ask($agent, 'whatsapp')->assertForbidden();
        $this->ask($agent, 'export')->assertForbidden();
        $this->ask($this->dataset->admin, 'timeseries', ['metric' => 'nonsense'])->assertStatus(422);
        $this->ask($this->dataset->admin, 'overview', ['from' => '2026-03-27', 'to' => '2026-03-20'])->assertStatus(422);
    }
}
