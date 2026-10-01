<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Actions\ReplaceDomains;
use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\WidgetPresenter;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Database\Connection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Domain whitelist rules at the widget level: schemes (https by default, plain http only on request or on development
 * hosts), wildcards below public suffixes, the width of the `host` column, and double submits.
 */
class WidgetDomainRulesTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
    }

    private function putDomains(Widget $widget, array $domains): TestResponse
    {
        return $this->actingAs($this->admin, 'sanctum')->putJson('/api/v1/widgets/'.$widget->ulid.'/domains', ['domains' => $domains]);
    }

    // ---- schemes -------------------------------------------------------------------------------------------------

    public function test_an_http_prefix_is_stored_as_given_and_the_https_prefix_is_dropped(): void
    {
        $widget = Widget::factory()->create();

        $response = $this->putDomains($widget, ['http://Legacy.Example.com/', 'https://secure.example.com:443', 'http://localhost:3000', 'http://*.old.example.org', 'plain.example.net'])->assertOk();

        $expected = ['http://*.old.example.org', 'http://legacy.example.com', 'http://localhost:3000', 'plain.example.net', 'secure.example.com'];
        $this->assertSame($expected, $response->json('data.domains'));
        $this->assertSame($expected, $widget->domains()->pluck('host')->all());
        $this->assertSame(
            ['http://*.old.example.org' => true, 'http://legacy.example.com' => false, 'http://localhost:3000' => false, 'plain.example.net' => false, 'secure.example.com' => false],
            $widget->domains()->get()->mapWithKeys(fn (WidgetDomain $domain): array => [$domain->host => $domain->is_wildcard])->all(),
            'the wildcard flag looks through the scheme prefix',
        );
    }

    public function test_the_builder_shows_the_domains_as_stored(): void
    {
        $widget = Widget::factory()->withDomains(['http://legacy.example.com', 'secure.example.com'])->create();

        $builder = app(WidgetPresenter::class)->builder($widget->fresh());

        $this->assertSame(['http://legacy.example.com', 'secure.example.com'], $builder->domains);
    }

    public function test_the_public_api_admits_plain_http_only_for_explicit_entries_and_development_hosts(): void
    {
        $widget = $this->enabledWidget(['secure.example.com', 'http://legacy.example.com', 'localhost:5174', 'shop.test']);
        $url = '/api/v1/public/widgets/'.$widget->public_key.'/config';
        $fetch = fn (string $origin) => $this->withHeaders(['Origin' => $origin])->getJson($url);

        $fetch('https://secure.example.com')->assertOk();
        $fetch('http://secure.example.com')->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed')->assertHeaderMissing('Access-Control-Allow-Origin');
        $fetch('http://legacy.example.com')->assertOk()->assertHeader('Access-Control-Allow-Origin', 'http://legacy.example.com');
        $fetch('https://legacy.example.com')->assertOk();
        $fetch('http://localhost:5174')->assertOk();
        $fetch('http://shop.test')->assertOk();
        $fetch('http://www.legacy.example.com')->assertForbidden();
    }

    public function test_the_iframe_may_be_framed_over_plain_http_only_when_the_entry_says_so(): void
    {
        $widget = $this->enabledWidget(['secure.example.com', 'http://legacy.example.com']);

        $this->get('/embed/'.$widget->public_key)
            ->assertOk()
            ->assertHeader('Content-Security-Policy', 'frame-ancestors http://legacy.example.com secure.example.com');
    }

    // ---- public suffixes ---------------------------------------------------------------------------------------------

    public function test_wildcards_on_public_suffixes_are_refused_with_a_hint(): void
    {
        $widget = Widget::factory()->withDomains(['keep.test'])->create();

        $response = $this->putDomains($widget, ['*.co.uk', '*.github.io', '*.example.co.uk', 'example.co.uk', '*.com'])->assertStatus(422);

        $this->assertSame(['domains.0', 'domains.1', 'domains.4'], array_keys($response->json('error.details')));
        $this->assertStringContainsString('*.co.uk', $response->json('error.details')['domains.0'][0]);
        $this->assertStringContainsString('not *.co.uk', $response->json('error.details')['domains.0'][0]);
        $this->assertSame(['keep.test'], $widget->domains()->pluck('host')->all(), 'nothing changed');

        $this->putDomains($widget, ['*.example.co.uk', 'example.co.uk'])->assertOk()->assertJsonPath('data.domains', ['*.example.co.uk', 'example.co.uk']);
    }

    // ---- the width of the column --------------------------------------------------------------------------------------

    public function test_entries_wider_than_the_host_column_are_refused(): void
    {
        $widget = Widget::factory()->create();
        $base = str_repeat('a', 63).'.'.str_repeat('b', 63).'.'.str_repeat('c', 63).'.'.str_repeat('d', 57).'.com';
        $this->assertSame(253, strlen($base));

        $response = $this->putDomains($widget, [str_repeat('x', 256), 'http://'.$base.':65535', $base, '*.'.substr($base, 0, 251)])->assertStatus(422);

        $this->assertSame(['domains.0', 'domains.1'], array_keys($response->json('error.details')));

        $this->putDomains($widget, [$base, '*.'.substr($base, 0, 251)])->assertOk();
        $this->assertSame(0, $widget->domains()->whereRaw('length(host) > 255')->count());
        $this->assertSame(2, $widget->domains()->count());
    }

    // ---- double submits ------------------------------------------------------------------------------------------------

    public function test_submitting_the_same_list_twice_is_harmless(): void
    {
        $widget = Widget::factory()->create();

        $this->putDomains($widget, ['a.example.com', '*.b.example.com'])->assertOk();
        $this->putDomains($widget, ['a.example.com', '*.b.example.com'])->assertOk();

        $this->assertSame(['*.b.example.com', 'a.example.com'], $widget->domains()->pluck('host')->all());
    }

    public function test_a_competing_request_inserting_the_same_host_in_between_does_not_fail(): void
    {
        $widget = Widget::factory()->create();
        $raced = false;

        // The other request commits its row right before this one writes: with read-then-insert this was a unique violation.
        DB::beforeExecuting(function (string $query, array $bindings, Connection $connection) use ($widget, &$raced): void {
            if ($raced || ! str_starts_with($query, 'insert into "widget_domains"')) {
                return;
            }

            $raced = true;
            $connection->table('widget_domains')->insert(['widget_id' => $widget->id, 'host' => 'a.example.com', 'is_wildcard' => false, 'created_at' => now(), 'updated_at' => now()]);
        });

        $stored = app(ReplaceDomains::class)->handle($widget, ['a.example.com', 'b.example.com']);

        $this->assertTrue($raced, 'the race was staged');
        $this->assertSame(['a.example.com', 'b.example.com'], $stored);
        $this->assertSame(['a.example.com', 'b.example.com'], $widget->domains()->pluck('host')->all());
        $this->assertSame(2, WidgetDomain::query()->where('widget_id', $widget->id)->count());
    }

    public function test_the_matcher_limit_matches_the_column(): void
    {
        $this->assertSame(255, OriginMatcher::MAX_STORED_LENGTH);
    }
}
