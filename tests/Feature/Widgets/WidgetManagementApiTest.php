<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Identity\IdentityFailure;
use App\Domain\Widgets\Identity\IdentityTokenVerifier;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetGreeting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class WidgetManagementApiTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
    }

    private function asAdmin(): static
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    private function widget(): Widget
    {
        return Widget::factory()->create(['name' => 'Main site']);
    }

    // ---- authorization -----------------------------------------------------------------------------------------

    /**
     * @return array<string, array{0: string, 1: string, 2: array<string, mixed>}>
     */
    public static function endpoints(): array
    {
        return [
            'list' => ['GET', '/api/v1/widgets', []],
            'create' => ['POST', '/api/v1/widgets', ['name' => 'X']],
            'show' => ['GET', '/api/v1/widgets/{ulid}', []],
            'update' => ['PATCH', '/api/v1/widgets/{ulid}', ['name' => 'Y']],
            'delete' => ['DELETE', '/api/v1/widgets/{ulid}', []],
            'draft' => ['PUT', '/api/v1/widgets/{ulid}/draft', ['config' => []]],
            'publish' => ['POST', '/api/v1/widgets/{ulid}/publish', []],
            'domains' => ['PUT', '/api/v1/widgets/{ulid}/domains', ['domains' => ['example.com']]],
            'greetings' => ['PUT', '/api/v1/widgets/{ulid}/greetings', ['greetings' => []]],
            'categories' => ['PUT', '/api/v1/widgets/{ulid}/categories', ['category_ulids' => []]],
            'rotate secret' => ['POST', '/api/v1/widgets/{ulid}/rotate-secret', []],
            'snippet' => ['GET', '/api/v1/widgets/{ulid}/snippet', []],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('endpoints')]
    public function test_every_endpoint_is_admin_only(string $method, string $uri, array $body): void
    {
        $uri = str_replace('{ulid}', $this->widget()->ulid, $uri);

        $this->json($method, $uri, $body)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');

        $this->actingAs(User::factory()->agent()->create(), 'sanctum')->json($method, $uri, $body)
            ->assertForbidden()->assertJsonPath('error.code', 'forbidden');

        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->json($method, $uri, $body)->assertForbidden();

        $status = $this->asAdmin()->json($method, $uri, $body)->status();
        $this->assertContains($status, [200, 201, 204], "{$method} {$uri} answered {$status} for an admin");
    }

    public function test_a_deactivated_admin_is_turned_away(): void
    {
        $this->actingAs(User::factory()->admin()->inactive()->create(), 'sanctum')->getJson('/api/v1/widgets')->assertStatus(401);
    }

    // ---- CRUD --------------------------------------------------------------------------------------------------

    public function test_creating_a_widget(): void
    {
        $response = $this->asAdmin()->postJson('/api/v1/widgets', ['name' => 'Help center']);

        $response->assertCreated()
            ->assertJsonPath('data.name', 'Help center')
            ->assertJsonPath('data.is_enabled', false)
            ->assertJsonPath('data.locale', 'en')
            ->assertJsonPath('data.idle_timeout_minutes', 120)
            ->assertJsonPath('data.queue_timeout_seconds', 90)
            ->assertJsonPath('data.offline_mode', 'auto_hours')
            ->assertJsonPath('data.timezone', 'UTC')
            ->assertJsonPath('data.allow_non_browser_clients', false)
            ->assertJsonPath('data.config_version', 1)
            ->assertJsonPath('data.has_identity_secret', false)
            ->assertJsonPath('data.has_unpublished_changes', false)
            ->assertJsonPath('data.whatsapp_connected', false);

        $data = $response->json('data');
        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', $data['ulid']);
        $this->assertMatchesRegularExpression('/^wk_[a-z0-9]{20}$/', $data['public_key']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $data['created_at']);
        $this->assertNoIntegerIds($data);
        $this->assertNoSecrets($data);
        $this->assertSame(
            ['ulid', 'name', 'public_key', 'is_enabled', 'locale', 'idle_timeout_minutes', 'queue_timeout_seconds', 'offline_mode', 'timezone', 'allow_non_browser_clients', 'config_version', 'has_identity_secret', 'has_unpublished_changes', 'whatsapp_connected', 'created_at', 'updated_at'],
            array_keys($data),
        );

        $widget = Widget::query()->where('ulid', $data['ulid'])->firstOrFail();
        $this->assertSame($widget->config, $widget->draft_config);
        $this->assertNull($widget->identity_secret_encrypted);
        $this->assertDatabaseHas('audit_logs', ['action' => 'widget.created', 'actor_id' => $this->admin->id, 'subject_type' => Widget::class, 'subject_id' => (string) $widget->id]);
    }

    public function test_a_name_is_required(): void
    {
        $this->asAdmin()->postJson('/api/v1/widgets', [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')->assertJsonPath('error.details.name.0', 'The name field is required.');
        $this->asAdmin()->postJson('/api/v1/widgets', ['name' => str_repeat('x', 121)])->assertStatus(422);
    }

    public function test_every_widget_gets_its_own_public_key(): void
    {
        $keys = collect(range(1, 5))->map(fn (): string => $this->asAdmin()->postJson('/api/v1/widgets', ['name' => 'W'])->json('data.public_key'));

        $this->assertCount(5, $keys->unique());
    }

    public function test_listing_widgets(): void
    {
        $first = Widget::factory()->enabled()->withDomains(['a.test', 'b.test'])->create(['name' => 'Alpha']);
        $first->categories()->attach(Category::factory()->create()->id, ['sort_order' => 0]);
        Widget::factory()->create(['name' => 'Beta']);

        $response = $this->asAdmin()->getJson('/api/v1/widgets')->assertOk();

        $response->assertJsonPath('meta.next_cursor', null)
            ->assertJsonPath('data.0.name', 'Alpha')
            ->assertJsonPath('data.0.domains_count', 2)
            ->assertJsonPath('data.0.categories_count', 1)
            ->assertJsonPath('data.0.is_enabled', true)
            ->assertJsonPath('data.1.name', 'Beta')
            ->assertJsonPath('data.1.domains_count', 0);
        $this->assertSame(
            ['ulid', 'name', 'public_key', 'is_enabled', 'config_version', 'has_unpublished_changes', 'whatsapp_connected', 'updated_at', 'domains_count', 'categories_count'],
            array_keys($response->json('data.0')),
        );
        $this->assertNoIntegerIds($response->json());
    }

    public function test_showing_and_missing_widgets(): void
    {
        $widget = $this->widget();

        $this->asAdmin()->getJson('/api/v1/widgets/'.$widget->ulid)->assertOk()->assertJsonPath('data.public_key', $widget->public_key);
        $this->asAdmin()->getJson('/api/v1/widgets/01hzzzzzzzzzzzzzzzzzzzzzzz')->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->asAdmin()->getJson('/api/v1/widgets/not-a-ulid')->assertNotFound();
        $this->asAdmin()->getJson('/api/v1/widgets/'.$widget->id)->assertNotFound();
        $this->asAdmin()->getJson('/api/v1/widgets/'.$widget->public_key)->assertNotFound();
    }

    public function test_updating_operational_settings(): void
    {
        $widget = $this->widget();

        $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, [
            'name' => 'Renamed',
            'is_enabled' => true,
            'locale' => 'ar',
            'idle_timeout_minutes' => 30,
            'queue_timeout_seconds' => 45,
            'offline_mode' => 'always_offline',
            'timezone' => 'Asia/Riyadh',
            'allow_non_browser_clients' => true,
        ])->assertOk()
            ->assertJsonPath('data.name', 'Renamed')
            ->assertJsonPath('data.is_enabled', true)
            ->assertJsonPath('data.locale', 'ar')
            ->assertJsonPath('data.idle_timeout_minutes', 30)
            ->assertJsonPath('data.queue_timeout_seconds', 45)
            ->assertJsonPath('data.offline_mode', 'always_offline')
            ->assertJsonPath('data.timezone', 'Asia/Riyadh')
            ->assertJsonPath('data.allow_non_browser_clients', true)
            ->assertJsonPath('data.has_unpublished_changes', false);

        $widget->refresh();

        foreach ([$widget->config, $widget->draft_config] as $config) {
            $this->assertSame('ar', $config['defaultLocale']);
            $this->assertSame('always_offline', $config['hours']['mode']);
            $this->assertSame('Asia/Riyadh', $config['hours']['timezone']);
            $this->assertSame(45, $config['routing']['queueTimeoutSeconds']);
            $this->assertSame(30, $config['session']['idleTimeoutMinutes']);
        }

        $this->assertDatabaseHas('audit_logs', ['action' => 'widget.updated', 'subject_id' => (string) $widget->id]);
        $audit = AuditLog::query()->where('action', 'widget.updated')->firstOrFail();
        $this->assertSame('always_offline', $audit->changes['offline_mode']);
    }

    public function test_a_settings_change_leaves_unpublished_draft_edits_of_other_fields_alone(): void
    {
        $widget = $this->widget();

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', ['config' => [
            'defaultLocale' => 'de',
            'hours' => ['timezone' => 'Europe/Berlin'],
            'routing' => ['queueTimeoutSeconds' => 120],
        ]])->assertOk();

        // Unrelated settings do not touch the draft.
        $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, ['name' => 'Renamed', 'is_enabled' => true])->assertOk()->assertJsonPath('data.has_unpublished_changes', true);
        $draft = $widget->refresh()->draft_config;
        $this->assertSame('de', $draft['defaultLocale']);
        $this->assertSame('Europe/Berlin', $draft['hours']['timezone']);
        $this->assertSame(120, $draft['routing']['queueTimeoutSeconds']);

        // A mirrored setting is written into the published config and the draft; the other draft edits survive.
        $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, ['idle_timeout_minutes' => 45])->assertOk();
        $widget->refresh();
        $this->assertSame(45, $widget->config['session']['idleTimeoutMinutes']);
        $this->assertSame(45, $widget->draft_config['session']['idleTimeoutMinutes']);
        $this->assertSame('de', $widget->draft_config['defaultLocale']);
        $this->assertSame('en', $widget->config['defaultLocale'], 'the published config keeps the old locale until publish');
        $this->assertSame('UTC', $widget->config['hours']['timezone']);
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidSettings(): array
    {
        return [
            'idle timeout too low' => [['idle_timeout_minutes' => 4], 'idle_timeout_minutes'],
            'idle timeout too high' => [['idle_timeout_minutes' => 10081], 'idle_timeout_minutes'],
            'queue timeout too low' => [['queue_timeout_seconds' => 14], 'queue_timeout_seconds'],
            'queue timeout too high' => [['queue_timeout_seconds' => 601], 'queue_timeout_seconds'],
            'offline mode unknown' => [['offline_mode' => 'sometimes'], 'offline_mode'],
            'timezone unknown' => [['timezone' => 'Mars/Olympus'], 'timezone'],
            'locale invalid' => [['locale' => 'english'], 'locale'],
            'locale longer than the varchar(12) column' => [['locale' => 'zh-Hant-12345'], 'locale'],
            'locale in the longest accepted shape' => [['locale' => 'abc-abcdefgh-abcdefgh'], 'locale'],
            'name empty' => [['name' => ''], 'name'],
            'enabled not boolean' => [['is_enabled' => 'maybe'], 'is_enabled'],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('invalidSettings')]
    public function test_invalid_settings_are_rejected(array $body, string $field): void
    {
        $this->asAdmin()->patchJson('/api/v1/widgets/'.$this->widget()->ulid, $body)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => [$field]]]);
    }

    public function test_the_boundary_values_of_the_settings_are_accepted(): void
    {
        $widget = $this->widget();

        foreach ([['idle_timeout_minutes' => 5], ['idle_timeout_minutes' => 10080], ['queue_timeout_seconds' => 15], ['queue_timeout_seconds' => 600], ['locale' => 'zh-Hant-1234']] as $body) {
            $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, $body)->assertOk();
        }
    }

    public function test_deleting_a_widget_is_soft_and_hides_it_everywhere(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->create();
        $key = $widget->public_key;

        $this->asAdmin()->deleteJson('/api/v1/widgets/'.$widget->ulid)->assertNoContent();

        $this->assertSoftDeleted('widgets', ['id' => $widget->id]);
        $this->asAdmin()->getJson('/api/v1/widgets/'.$widget->ulid)->assertNotFound();
        $this->asAdmin()->getJson('/api/v1/widgets')->assertJsonCount(0, 'data');
        $this->withHeaders(['Origin' => 'https://customer.test'])->getJson('/api/v1/public/widgets/'.$key.'/config')->assertNotFound();
        $this->assertDatabaseHas('audit_logs', ['action' => 'widget.deleted']);
    }

    public function test_settings_changes_reach_visitors_immediately(): void
    {
        $widget = $this->enabledWidget(['customer.test']);
        $headers = ['Origin' => 'https://customer.test'];
        $url = '/api/v1/public/widgets/'.$widget->public_key.'/config';

        $this->withHeaders($headers)->getJson($url)->assertJsonPath('data.locale', 'en');

        $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, ['locale' => 'ar', 'timezone' => 'Asia/Riyadh'])->assertOk();

        $served = $this->withHeaders($headers)->getJson($url)->assertOk();
        $served->assertJsonPath('data.locale', 'ar')->assertJsonPath('data.config.defaultLocale', 'ar')->assertJsonPath('data.config.hours.timezone', 'Asia/Riyadh');

        $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, ['is_enabled' => false])->assertOk();
        $this->withHeaders($headers)->getJson($url)->assertNotFound();
    }

    // ---- draft and publish -------------------------------------------------------------------------------------

    public function test_saving_a_draft_does_not_touch_visitors(): void
    {
        $widget = $this->enabledWidget(['customer.test']);
        $headers = ['Origin' => 'https://customer.test'];
        $url = '/api/v1/public/widgets/'.$widget->public_key.'/config';

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', ['config' => ['theme' => ['primary' => '#112233'], 'launcher' => ['label' => 'Ask us']]])
            ->assertOk()
            ->assertJsonPath('data.has_unpublished_changes', true)
            ->assertJsonPath('data.config_version', 1);

        $widget->refresh();
        $this->assertSame('#112233', $widget->draft_config['theme']['primary']);
        $this->assertSame('#0f766e', $widget->config['theme']['primary']);
        $this->assertSame('Ask us', $widget->draft_config['launcher']['label']);
        $this->assertArrayHasKey('routing', $widget->draft_config, 'the draft is stored complete (defaults filled)');

        $this->withHeaders($headers)->getJson($url)->assertJsonPath('data.config.theme.primary', '#0f766e')->assertJsonPath('data.config.launcher.label', 'Chat with us');
        $this->assertDatabaseHas('audit_logs', ['action' => 'widget.draft_saved']);
    }

    public function test_an_invalid_draft_is_rejected_with_field_errors_and_nothing_is_saved(): void
    {
        $widget = $this->widget();

        $response = $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', ['config' => [
            'theme' => ['primary' => 'red', 'colour' => '#fff', 'radius' => 99],
            'surprise' => true,
        ]]);

        $response->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $details = $response->json('error.details');
        $this->assertArrayHasKey('config.theme.primary', $details);
        $this->assertArrayHasKey('config.theme.radius', $details);
        $this->assertSame(['Unknown option.'], $details['config.theme.colour']);
        $this->assertSame(['Unknown option.'], $details['config.surprise']);

        $this->assertSame($widget->config, $widget->refresh()->draft_config);
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', [])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['config']]]);
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', ['config' => 'nope'])->assertStatus(422);
    }

    public function test_publishing_copies_the_draft_bumps_the_version_and_syncs_the_mirrored_columns(): void
    {
        $widget = $this->enabledWidget(['customer.test']);

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/draft', ['config' => [
            'theme' => ['primary' => '#abcdef'],
            'defaultLocale' => 'de',
            'hours' => ['mode' => 'always_online', 'timezone' => 'Europe/Berlin'],
            'routing' => ['queueTimeoutSeconds' => 120],
            'session' => ['idleTimeoutMinutes' => 60],
        ]])->assertOk();

        $this->assertSame('en', $widget->refresh()->locale, 'columns follow the draft only once it is published');

        $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/publish')
            ->assertOk()
            ->assertJsonPath('data.config_version', 2)
            ->assertJsonPath('data.has_unpublished_changes', false)
            ->assertJsonPath('data.locale', 'de')
            ->assertJsonPath('data.offline_mode', 'always_online')
            ->assertJsonPath('data.timezone', 'Europe/Berlin')
            ->assertJsonPath('data.queue_timeout_seconds', 120)
            ->assertJsonPath('data.idle_timeout_minutes', 60);

        $widget->refresh();
        $this->assertSame('#abcdef', $widget->config['theme']['primary']);
        $this->assertSame($widget->config, $widget->draft_config);

        $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/publish')->assertOk()->assertJsonPath('data.config_version', 3);
        $audit = AuditLog::query()->where('action', 'widget.published')->latest('id')->firstOrFail();
        $this->assertSame(['from' => 2, 'to' => 3], $audit->changes['config_version']);
    }

    // ---- domains -----------------------------------------------------------------------------------------------

    public function test_domains_are_normalised_deduplicated_and_replace_the_set(): void
    {
        $widget = Widget::factory()->withDomains(['old.test'])->create();

        $response = $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => [
            'Example.COM', 'https://example.com/', '*.Shop.Example.com', 'localhost:3000', 'münchen.de',
        ]])->assertOk();

        $this->assertSame(['*.shop.example.com', 'example.com', 'localhost:3000', 'xn--mnchen-3ya.de'], $response->json('data.domains'));
        $this->assertSame(['*.shop.example.com', 'example.com', 'localhost:3000', 'xn--mnchen-3ya.de'], $widget->domains()->pluck('host')->all());
        $this->assertTrue((bool) $widget->domains()->where('host', '*.shop.example.com')->value('is_wildcard'));
        $this->assertFalse((bool) $widget->domains()->where('host', 'example.com')->value('is_wildcard'));

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => []])->assertOk()->assertJsonPath('data.domains', []);
        $this->assertSame(0, $widget->domains()->count());
    }

    public function test_invalid_domains_are_rejected_with_their_index(): void
    {
        $widget = Widget::factory()->withDomains(['keep.test'])->create();

        $response = $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => [
            'ok.test', 'https://user@evil.test', '*.com', 'a.test/path', 'bad host',
        ]]);

        $response->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(['domains.1', 'domains.2', 'domains.3', 'domains.4'], array_keys($response->json('error.details')));
        $this->assertSame(['keep.test'], $widget->domains()->pluck('host')->all(), 'nothing changed');

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', [])->assertStatus(422);
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => array_map(fn (int $i): string => "host{$i}.test", range(1, 51))])->assertStatus(422);
    }

    public function test_changing_domains_takes_effect_for_the_public_api_at_once(): void
    {
        $widget = $this->enabledWidget(['customer.test']);
        $url = '/api/v1/public/widgets/'.$widget->public_key.'/config';

        $this->withHeaders(['Origin' => 'https://new.test'])->getJson($url)->assertForbidden();

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => ['new.test']])->assertOk();

        $this->withHeaders(['Origin' => 'https://new.test'])->getJson($url)->assertOk();
        $this->withHeaders(['Origin' => 'https://customer.test'])->getJson($url)->assertForbidden();
    }

    // ---- greetings ---------------------------------------------------------------------------------------------

    public function test_the_greeting_pool_is_replaced(): void
    {
        $widget = $this->widget();
        $keep = WidgetGreeting::factory()->for($widget)->create(['body' => 'Old text', 'weight' => 1]);
        $drop = WidgetGreeting::factory()->for($widget)->create(['body' => 'Dropped']);

        $response = $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/greetings', ['greetings' => [
            ['ulid' => $keep->ulid, 'body' => 'Updated <b>text</b>', 'agent_name' => 'Sara', 'agent_avatar_url' => 'https://cdn.example.com/sara.png', 'locale' => 'en', 'weight' => 5, 'is_active' => true, 'sort_order' => 7],
            ['body' => 'Brand new', 'is_active' => false],
        ]])->assertOk();

        $data = $response->json('data');
        $this->assertCount(2, $data);
        $this->assertSame(['Brand new', 'Updated <b>text</b>'], array_column($data, 'body'), 'the pool is returned in sort order');

        $updated = collect($data)->firstWhere('ulid', $keep->ulid);
        $this->assertNotNull($updated, 'known ULIDs are updated in place');
        $this->assertSame('Updated <b>text</b>', $updated['body'], 'plain text is stored as typed, never rewritten');
        $this->assertSame(
            ['agent_name' => 'Sara', 'agent_avatar_url' => 'https://cdn.example.com/sara.png', 'locale' => 'en', 'weight' => 5, 'is_active' => true, 'sort_order' => 7],
            array_intersect_key($updated, array_flip(['agent_name', 'agent_avatar_url', 'locale', 'weight', 'is_active', 'sort_order'])),
        );

        $created = collect($data)->firstWhere('body', 'Brand new');
        $this->assertSame(
            ['agent_name' => null, 'weight' => 1, 'is_active' => false, 'sort_order' => 1],
            array_intersect_key($created, array_flip(['agent_name', 'weight', 'is_active', 'sort_order'])),
            'defaults: weight 1, position as order',
        );
        $this->assertNotSame($drop->ulid, $created['ulid']);
        $this->assertSame(['ulid', 'body', 'agent_name', 'agent_avatar_url', 'locale', 'weight', 'is_active', 'sort_order'], array_keys($updated));
        $this->assertDatabaseMissing('widget_greetings', ['id' => $drop->id]);
        $this->assertNoIntegerIds($response->json());
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidGreetings(): array
    {
        return [
            'body missing' => [['agent_name' => 'x'], 'greetings.0.body'],
            'body too long' => [['body' => str_repeat('x', 2001)], 'greetings.0.body'],
            'body with control characters' => [['body' => "bad\x00body"], 'greetings.0.body'],
            'weight zero' => [['body' => 'x', 'weight' => 0], 'greetings.0.weight'],
            'weight above 100' => [['body' => 'x', 'weight' => 101], 'greetings.0.weight'],
            'avatar over http' => [['body' => 'x', 'agent_avatar_url' => 'http://example.com/a.png'], 'greetings.0.agent_avatar_url'],
            'avatar javascript' => [['body' => 'x', 'agent_avatar_url' => 'javascript:alert(1)'], 'greetings.0.agent_avatar_url'],
            'locale invalid' => [['body' => 'x', 'locale' => 'x y'], 'greetings.0.locale'],
            'locale longer than the varchar(12) column' => [['body' => 'x', 'locale' => 'zh-Hant-12345'], 'greetings.0.locale'],
            'agent name too long' => [['body' => 'x', 'agent_name' => str_repeat('x', 121)], 'greetings.0.agent_name'],
            'unknown greeting' => [['ulid' => '01hzzzzzzzzzzzzzzzzzzzzzzz', 'body' => 'x'], 'greetings.0.ulid'],
            'ulid malformed' => [['ulid' => 'nope', 'body' => 'x'], 'greetings.0.ulid'],
            'sort order negative' => [['body' => 'x', 'sort_order' => -1], 'greetings.0.sort_order'],
        ];
    }

    /**
     * @param  array<string, mixed>  $greeting
     */
    #[DataProvider('invalidGreetings')]
    public function test_invalid_greetings_are_rejected(array $greeting, string $field): void
    {
        $widget = $this->widget();

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/greetings', ['greetings' => [$greeting]])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => [$field]]]);
        $this->assertSame(0, $widget->greetings()->count());
    }

    public function test_new_greetings_may_carry_a_null_ulid(): void
    {
        $widget = $this->widget();

        $response = $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/greetings', ['greetings' => [
            ['ulid' => null, 'body' => 'First', 'agent_name' => null, 'agent_avatar_url' => null, 'locale' => null, 'weight' => 1, 'is_active' => true, 'sort_order' => 0],
            ['ulid' => null, 'body' => 'Second', 'agent_name' => null, 'agent_avatar_url' => null, 'locale' => null, 'weight' => 2, 'is_active' => true, 'sort_order' => 1],
        ]])->assertOk();

        $this->assertSame(['First', 'Second'], array_column($response->json('data'), 'body'));
        $this->assertCount(2, array_unique(array_column($response->json('data'), 'ulid')));

        // Sending the same existing ULID twice is a mistake.
        $ulid = $response->json('data.0.ulid');
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/greetings', ['greetings' => [['ulid' => $ulid, 'body' => 'A'], ['ulid' => $ulid, 'body' => 'B']]])->assertStatus(422);
    }

    public function test_a_greeting_of_another_widget_cannot_be_hijacked(): void
    {
        $mine = $this->widget();
        $other = Widget::factory()->create();
        $foreign = WidgetGreeting::factory()->for($other)->create(['body' => 'Not yours']);

        $this->asAdmin()->putJson('/api/v1/widgets/'.$mine->ulid.'/greetings', ['greetings' => [['ulid' => $foreign->ulid, 'body' => 'Taken over']]])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['greetings.0.ulid']]]);

        $this->assertSame('Not yours', $foreign->refresh()->body);
        $this->assertSame($other->id, $foreign->widget_id);
    }

    public function test_at_most_one_hundred_greetings(): void
    {
        $greetings = array_map(fn (int $i): array => ['body' => "Greeting {$i}"], range(1, 101));

        $this->asAdmin()->putJson('/api/v1/widgets/'.$this->widget()->ulid.'/greetings', ['greetings' => $greetings])->assertStatus(422);
    }

    // ---- categories --------------------------------------------------------------------------------------------

    public function test_enabled_categories_are_replaced_in_order(): void
    {
        $widget = $this->widget();
        [$a, $b, $c] = Category::factory()->count(3)->create()->all();
        $widget->categories()->attach($a->id, ['sort_order' => 0]);

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/categories', ['category_ulids' => [$c->ulid, $a->ulid, $b->ulid]])
            ->assertOk()
            ->assertJsonPath('data.category_ulids', [$c->ulid, $a->ulid, $b->ulid]);
        $this->assertSame([$c->ulid, $a->ulid, $b->ulid], $widget->categories()->pluck('ulid')->all());

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/categories', ['category_ulids' => [$b->ulid]])->assertOk();
        $this->assertSame([$b->ulid], $widget->categories()->pluck('ulid')->all());
    }

    public function test_unknown_deleted_and_duplicate_categories_are_rejected(): void
    {
        $widget = $this->widget();
        $gone = Category::factory()->create();
        $gone->delete();
        $live = Category::factory()->create();

        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/categories', ['category_ulids' => [$live->ulid, '01hzzzzzzzzzzzzzzzzzzzzzzz', $gone->ulid]])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['category_ulids.1', 'category_ulids.2']]]);
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/categories', ['category_ulids' => [$live->ulid, $live->ulid]])->assertStatus(422);
        $this->asAdmin()->putJson('/api/v1/widgets/'.$widget->ulid.'/categories', [])->assertStatus(422);
        $this->assertSame(0, $widget->categories()->count());
    }

    // ---- identity secret ---------------------------------------------------------------------------------------

    public function test_the_identity_secret_is_returned_once_and_stored_encrypted(): void
    {
        $widget = $this->enabledWidget(['customer.test']);

        $response = $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/rotate-secret')->assertOk();

        $secret = $response->json('data.identity_secret');
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $secret, '32 random bytes, hex encoded');
        $this->assertSame(['data' => ['identity_secret' => $secret]], $response->json());
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));

        $stored = (string) $widget->refresh()->identity_secret_encrypted;
        $this->assertNotSame($secret, $stored);
        $this->assertStringNotContainsString($secret, $stored);
        $this->assertSame($secret, Crypt::decryptString($stored));
        $this->assertSame($secret, $widget->identitySecret());
        $this->assertDatabaseMissing('widgets', ['identity_secret_encrypted' => $secret]);

        // Nothing ever shows it again.
        $this->assertTrue($this->asAdmin()->getJson('/api/v1/widgets/'.$widget->ulid)->assertOk()->json('data.has_identity_secret'));
        foreach (['/api/v1/widgets', '/api/v1/widgets/'.$widget->ulid, '/api/v1/widgets/'.$widget->ulid.'/snippet'] as $url) {
            $this->assertStringNotContainsString($secret, (string) $this->asAdmin()->getJson($url)->getContent(), $url);
        }
        $this->assertStringNotContainsString($secret, (string) $this->asAdmin()->patchJson('/api/v1/widgets/'.$widget->ulid, ['name' => 'N'])->getContent());
        $this->assertStringNotContainsString($secret, (string) $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/publish')->getContent());
        $this->assertStringNotContainsString($secret, (string) $this->withHeaders(['Origin' => 'https://customer.test'])->getJson('/api/v1/public/widgets/'.$widget->public_key.'/config')->getContent());
        $this->assertStringNotContainsString($secret, (string) json_encode(AuditLog::query()->get()->toArray()));
        $this->assertDatabaseHas('audit_logs', ['action' => 'widget.secret_rotated', 'subject_id' => (string) $widget->id]);
    }

    public function test_rotating_invalidates_tokens_signed_with_the_old_secret(): void
    {
        $widget = $this->widget();
        $verifier = app(IdentityTokenVerifier::class);

        $old = $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/rotate-secret')->json('data.identity_secret');
        $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => '1', 'exp' => time() + 120], $old);
        $this->assertTrue($verifier->verifyForWidget($token, $widget->refresh())->isValid());

        $new = $this->asAdmin()->postJson('/api/v1/widgets/'.$widget->ulid.'/rotate-secret')->json('data.identity_secret');
        $this->assertNotSame($old, $new);

        $this->assertSame(IdentityFailure::BadSignature, $verifier->verifyForWidget($token, $widget->refresh())->failure);
        $fresh = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => '1', 'exp' => time() + 120], $new);
        $this->assertTrue($verifier->verifyForWidget($fresh, $widget)->isValid());
    }

    public function test_a_widget_without_a_secret_never_verifies_identities(): void
    {
        $widget = $this->widget();
        $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'exp' => time() + 120], '');

        $this->assertSame(IdentityFailure::NoSecret, app(IdentityTokenVerifier::class)->verifyForWidget($token, $widget)->failure);
    }

    // ---- snippets ----------------------------------------------------------------------------------------------

    public function test_snippets_point_at_the_installation(): void
    {
        $widget = $this->widget();
        $origin = rtrim((string) config('app.url'), '/');

        $response = $this->asAdmin()->getJson('/api/v1/widgets/'.$widget->ulid.'/snippet')->assertOk();
        $data = $response->json('data');

        $this->assertSame(['script', 'iframe', 'hosted', 'identity_example'], array_keys($data));
        $this->assertStringContainsString('src="'.$origin.'/w/'.$widget->public_key.'.js"', $data['script']);
        $this->assertStringContainsString($origin.'/embed/'.$widget->public_key, $data['iframe']);
        $this->assertSame($origin.'/c/'.$widget->public_key, $data['hosted']);
        $this->assertSame(['php', 'node', 'python'], array_keys($data['identity_example']));

        foreach ($data['identity_example'] as $language => $example) {
            $this->assertStringContainsString($widget->public_key, $example, $language);
            $this->assertStringContainsString('HS256', $example, $language);
            $this->assertStringContainsString('300', $example, $language);
        }
    }
}
