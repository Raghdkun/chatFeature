<?php

namespace Tests\Feature\Agents;

use App\Auth\Enums\UserRole;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class AgentApiTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = User::factory()->admin()->create(['name' => 'Ada Admin']);
    }

    private function asAdmin(): static
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    // ---- authorization -----------------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string, 1: string, 2: array<string, mixed>}>
     */
    public static function endpoints(): array
    {
        return [
            'list' => ['GET', '/api/v1/agents', []],
            'create' => ['POST', '/api/v1/agents', ['name' => 'N', 'email' => 'n@example.test', 'password' => 'a-long-test-password']],
            'update' => ['PATCH', '/api/v1/agents/{id}', ['max_concurrent_chats' => 3]],
            'categories' => ['PATCH', '/api/v1/agents/{id}/categories', ['category_ulids' => []]],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('endpoints')]
    public function test_every_endpoint_is_admin_only(string $method, string $uri, array $body): void
    {
        $uri = str_replace('{id}', (string) User::factory()->agent()->create()->id, $uri);

        $this->json($method, $uri, $body)->assertUnauthorized();
        $this->actingAs(User::factory()->agent()->create(), 'sanctum')->json($method, $uri, $body)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->assertContains($this->asAdmin()->json($method, $uri, $body)->status(), [200, 201]);
    }

    // ---- list --------------------------------------------------------------------------------------------------

    public function test_the_staff_list(): void
    {
        $agent = User::factory()->agent()->create(['name' => 'Bob Agent', 'max_concurrent_chats' => 3, 'last_seen_at' => '2026-09-30 12:00:00']);
        $inactive = User::factory()->agent()->inactive()->create(['name' => 'Cy Inactive']);
        User::factory()->withoutChatAccess()->create(['name' => 'Dan Nobody']);
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);
        $deleted = Category::factory()->create();
        $deleted->users()->attach($agent->id);
        $deleted->delete();

        $response = $this->asAdmin()->getJson('/api/v1/agents')->assertOk()->assertJsonPath('meta.next_cursor', null);

        $this->assertSame(['Ada Admin', 'Bob Agent', 'Cy Inactive'], array_column($response->json('data'), 'name'), 'staff only, sorted by name');

        $row = collect($response->json('data'))->firstWhere('name', 'Bob Agent');
        $this->assertSame(
            ['id' => $agent->id, 'name' => 'Bob Agent', 'email' => $agent->email, 'avatar' => null, 'is_admin' => false, 'is_agent' => true, 'is_active' => true, 'auth_source' => 'local', 'category_ulids' => [$category->ulid], 'max_concurrent_chats' => 3, 'last_seen_at' => '2026-09-30T12:00:00.000Z'],
            $row,
        );
        $this->assertFalse(collect($response->json('data'))->firstWhere('id', $inactive->id)['is_active']);
        $this->assertTrue(collect($response->json('data'))->firstWhere('name', 'Ada Admin')['is_admin']);
        $this->assertNull(collect($response->json('data'))->firstWhere('name', 'Ada Admin')['last_seen_at']);
        $this->assertStringNotContainsString('password', (string) $response->getContent());
        $this->assertStringNotContainsString('remember_token', (string) $response->getContent());
        $this->assertStringNotContainsString('two_factor', (string) $response->getContent());
    }

    public function test_last_seen_is_written_when_an_agent_comes_and_goes(): void
    {
        $this->travelTo('2026-10-04 08:30:00');
        $seen = User::factory()->agent()->create(['name' => 'Eve Online']);
        User::factory()->agent()->create(['name' => 'Fay Never']);

        $this->actingAs($seen, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])->assertOk();
        $rows = collect($this->asAdmin()->getJson('/api/v1/agents')->assertOk()->json('data'));

        $this->assertSame('2026-10-04T08:30:00.000Z', $rows->firstWhere('name', 'Eve Online')['last_seen_at']);
        $this->assertNull($rows->firstWhere('name', 'Fay Never')['last_seen_at']);
    }

    // ---- create (mode 1) ---------------------------------------------------------------------------------------

    public function test_an_admin_creates_a_local_agent_in_mode_one(): void
    {
        $category = Category::factory()->create();

        $response = $this->asAdmin()->postJson('/api/v1/agents', [
            'name' => 'New Agent',
            'email' => 'new.agent@example.test',
            'password' => 'a-long-test-password',
            'is_agent' => true,
            'category_ulids' => [$category->ulid],
        ])->assertCreated();

        $response->assertJsonPath('data.name', 'New Agent')
            ->assertJsonPath('data.email', 'new.agent@example.test')
            ->assertJsonPath('data.is_agent', true)
            ->assertJsonPath('data.is_admin', false)
            ->assertJsonPath('data.is_active', true)
            ->assertJsonPath('data.auth_source', 'local')
            ->assertJsonPath('data.category_ulids', [$category->ulid])
            ->assertJsonPath('data.max_concurrent_chats', 5);

        $user = User::query()->where('email', 'new.agent@example.test')->firstOrFail();
        $this->assertSame(UserRole::Agent, $user->role);
        $this->assertTrue(Hash::check('a-long-test-password', (string) $user->password));
        $this->assertNotNull($user->email_verified_at, 'staff are never gated on email verification');
        $this->assertDatabaseHas('audit_logs', ['action' => 'agent.created', 'actor_id' => $this->admin->id, 'subject_id' => (string) $user->id]);
        $this->assertStringNotContainsString('a-long-test-password', (string) json_encode(AuditLog::query()->get()->toArray()));

        // The new agent can sign in to the dashboard.
        $this->post('/login', ['email' => 'new.agent@example.test', 'password' => 'a-long-test-password'])->assertRedirect(route('dashboard', absolute: false));
        $this->assertAuthenticatedAs($user, 'web');
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidAgents(): array
    {
        return [
            'name missing' => [['email' => 'a@example.test', 'password' => 'a-long-test-password'], 'name'],
            'email missing' => [['name' => 'A', 'password' => 'a-long-test-password'], 'email'],
            'email invalid' => [['name' => 'A', 'email' => 'nope', 'password' => 'a-long-test-password'], 'email'],
            'password missing' => [['name' => 'A', 'email' => 'a@example.test'], 'password'],
            'password too short' => [['name' => 'A', 'email' => 'a@example.test', 'password' => 'short'], 'password'],
            'is_agent false' => [['name' => 'A', 'email' => 'a@example.test', 'password' => 'a-long-test-password', 'is_agent' => false], 'is_agent'],
            'unknown category' => [['name' => 'A', 'email' => 'a@example.test', 'password' => 'a-long-test-password', 'category_ulids' => ['01hzzzzzzzzzzzzzzzzzzzzzzz']], 'category_ulids.0'],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('invalidAgents')]
    public function test_invalid_agents_are_rejected(array $body, string $field): void
    {
        $this->asAdmin()->postJson('/api/v1/agents', $body)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => [$field]]]);
        $this->assertSame(1, User::query()->count());
    }

    public function test_an_email_can_only_be_used_once(): void
    {
        User::factory()->agent()->create(['email' => 'taken@example.test']);

        $this->asAdmin()->postJson('/api/v1/agents', ['name' => 'A', 'email' => 'taken@example.test', 'password' => 'a-long-test-password'])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['email']]]);
    }

    // ---- mode 2 ------------------------------------------------------------------------------------------------

    public function test_creating_agents_is_refused_in_pizzasys_mode_before_the_body_is_read(): void
    {
        $this->usePizzasysMode();

        $this->asAdmin()->postJson('/api/v1/agents', ['name' => 'A', 'email' => 'a@example.test', 'password' => 'a-long-test-password'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'managed_by_auth_portal');
        $this->asAdmin()->postJson('/api/v1/agents', [])->assertStatus(409)->assertJsonPath('error.code', 'managed_by_auth_portal');
        $this->assertSame(1, User::query()->count());
    }

    public function test_activation_and_roles_are_refused_in_pizzasys_mode(): void
    {
        $this->usePizzasysMode();
        $agent = User::factory()->agent()->create(['auth_source' => 'pizzasys']);

        foreach ([['is_active' => false], ['is_agent' => true], ['is_active' => true, 'max_concurrent_chats' => 9]] as $body) {
            $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, $body)->assertStatus(409)->assertJsonPath('error.code', 'managed_by_auth_portal');
        }

        $agent->refresh();
        $this->assertTrue($agent->is_active);
        $this->assertSame(5, $agent->max_concurrent_chats, 'a rejected request changes nothing');
    }

    public function test_concurrency_and_categories_stay_editable_in_pizzasys_mode(): void
    {
        $this->usePizzasysMode();
        $agent = User::factory()->agent()->create(['auth_source' => 'pizzasys']);
        $category = Category::factory()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['max_concurrent_chats' => 9])->assertOk()->assertJsonPath('data.max_concurrent_chats', 9);
        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => [$category->ulid]])->assertOk()->assertJsonPath('data.category_ulids', [$category->ulid]);
        $this->asAdmin()->getJson('/api/v1/agents')->assertOk()->assertJsonPath('data.1.auth_source', 'pizzasys');
    }

    // ---- update (mode 1) ---------------------------------------------------------------------------------------

    public function test_updating_an_agent(): void
    {
        $agent = User::factory()->agent()->create();
        $agent->createToken('phone', ['staff']);

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['max_concurrent_chats' => 12])->assertOk()->assertJsonPath('data.max_concurrent_chats', 12);
        $this->assertSame(1, $agent->tokens()->count());

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => false])->assertOk()->assertJsonPath('data.is_active', false);
        $this->assertSame(0, $agent->tokens()->count(), 'deactivating revokes API tokens');

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => true])->assertOk()->assertJsonPath('data.is_active', true);
        $this->assertDatabaseHas('audit_logs', ['action' => 'agent.updated', 'subject_id' => (string) $agent->id]);
    }

    public function test_a_deactivated_agent_can_no_longer_use_the_api(): void
    {
        $agent = User::factory()->agent()->create();
        $token = $agent->createToken('phone', ['staff'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/categories')->assertOk();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => false])->assertOk();
        $this->app['auth']->forgetGuards();

        $this->withToken($token)->getJson('/api/v1/categories')->assertUnauthorized();
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidUpdates(): array
    {
        return [
            'concurrency zero' => [['max_concurrent_chats' => 0], 'max_concurrent_chats'],
            'concurrency too high' => [['max_concurrent_chats' => 51], 'max_concurrent_chats'],
            'concurrency text' => [['max_concurrent_chats' => 'many'], 'max_concurrent_chats'],
            'is_active text' => [['is_active' => 'perhaps'], 'is_active'],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('invalidUpdates')]
    public function test_invalid_updates_are_rejected(array $body, string $field): void
    {
        $agent = User::factory()->agent()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, $body)->assertStatus(422)->assertJsonStructure(['error' => ['details' => [$field]]]);
    }

    public function test_an_admin_cannot_deactivate_themselves(): void
    {
        $this->asAdmin()->patchJson('/api/v1/agents/'.$this->admin->id, ['is_active' => false])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'cannot_deactivate_self');

        $this->assertTrue($this->admin->refresh()->is_active);
        $this->asAdmin()->patchJson('/api/v1/agents/'.$this->admin->id, ['max_concurrent_chats' => 2])->assertOk();
    }

    public function test_only_admins_may_stop_taking_chats(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->admin()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['is_agent' => false])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['is_agent']]]);
        $this->assertTrue($agent->refresh()->is_agent);

        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id, ['is_agent' => false])->assertOk()->assertJsonPath('data.is_agent', false)->assertJsonPath('data.is_admin', true);
        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id, ['is_agent' => true])->assertOk()->assertJsonPath('data.is_agent', true);
    }

    public function test_only_staff_can_be_addressed(): void
    {
        $nobody = User::factory()->withoutChatAccess()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$nobody->id, ['max_concurrent_chats' => 3])->assertNotFound();
        $this->asAdmin()->patchJson('/api/v1/agents/999999', ['max_concurrent_chats' => 3])->assertNotFound();
        $this->asAdmin()->patchJson('/api/v1/agents/abc', ['max_concurrent_chats' => 3])->assertNotFound();
        $this->asAdmin()->patchJson('/api/v1/agents/'.$nobody->id.'/categories', ['category_ulids' => []])->assertNotFound();
    }

    // ---- categories --------------------------------------------------------------------------------------------

    public function test_an_admin_assigns_categories_including_inactive_ones(): void
    {
        $agent = User::factory()->agent()->create();
        $a = Category::factory()->create(['sort_order' => 1]);
        $b = Category::factory()->inactive()->create(['sort_order' => 2]);
        $a->users()->attach(User::factory()->agent()->create()->id);

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => [$b->ulid, $a->ulid]])
            ->assertOk()
            ->assertJsonPath('data.category_ulids', [$a->ulid, $b->ulid]);

        $this->assertSame(2, $a->users()->count(), 'other agents keep their assignments');

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => []])->assertOk()->assertJsonPath('data.category_ulids', []);
        $this->assertDatabaseHas('audit_logs', ['action' => 'agent.categories_updated', 'actor_id' => $this->admin->id]);
    }

    public function test_unknown_and_deleted_categories_cannot_be_assigned(): void
    {
        $agent = User::factory()->agent()->create();
        $deleted = Category::factory()->create();
        $deleted->delete();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => [$deleted->ulid, '01hzzzzzzzzzzzzzzzzzzzzzzz']])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['category_ulids.0', 'category_ulids.1']]]);
    }

    public function test_payloads_never_expose_secrets(): void
    {
        $agent = User::factory()->agent()->withTwoFactor()->create();

        $payload = $this->asAdmin()->getJson('/api/v1/agents')->assertOk()->json();

        $this->assertNoSecrets($payload);
        $this->assertStringNotContainsString((string) $agent->two_factor_secret, (string) json_encode($payload));
    }
}
