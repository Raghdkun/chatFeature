<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Actions\PublishWidget;
use App\Domain\Widgets\Actions\UpdateWidget;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Domain\Widgets\Support\NullPresenceReader;
use App\Models\Category;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class WidgetAvailabilityTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private Widget $widget;

    private Category $billing;

    private Category $sales;

    protected function setUp(): void
    {
        parent::setUp();

        $this->billing = Category::factory()->create(['slug' => 'billing']);
        $this->sales = Category::factory()->create(['slug' => 'sales']);
        $this->widget = $this->enabledWidget(['customer.test'], ['timezone' => 'America/New_York'], $this->billing);
        $this->widget->categories()->attach($this->sales->id, ['sort_order' => 1]);
    }

    private function service(): AvailabilityService
    {
        return app(AvailabilityService::class);
    }

    private function at(string $utc): CarbonImmutable
    {
        return CarbonImmutable::parse($utc, 'UTC');
    }

    public function test_without_a_presence_provider_nobody_is_online(): void
    {
        $this->assertInstanceOf(NullPresenceReader::class, app(PresenceReader::class));

        // Monday 10:00 New York: inside the default hours, but no agent is online.
        $availability = $this->service()->compute($this->widget, $this->at('2026-01-12 15:00:00'));

        $this->assertTrue($availability->openNow);
        $this->assertFalse($availability->online);
        $this->assertNull($availability->nextOpenAt);
        $this->assertFalse($availability->whatsapp->enabled);
        $this->assertSame([['slug' => 'billing', 'online' => false], ['slug' => 'sales', 'online' => false]], array_map(fn ($category): array => $category->toArray(), $availability->categories));
    }

    public function test_online_needs_open_hours_and_an_available_agent_per_category(): void
    {
        $this->fakePresence([$this->billing->id => 2]);

        $open = $this->service()->compute($this->widget, $this->at('2026-01-12 15:00:00'));

        $this->assertTrue($open->online);
        $this->assertSame([['slug' => 'billing', 'online' => true], ['slug' => 'sales', 'online' => false]], array_map(fn ($category): array => $category->toArray(), $open->categories));

        // Same agents, but Monday 20:00 New York is after closing time.
        $closed = $this->service()->compute($this->widget, $this->at('2026-01-13 01:00:00'));

        $this->assertFalse($closed->openNow);
        $this->assertFalse($closed->online);
        $this->assertSame([false, false], array_map(fn ($category): bool => $category->online, $closed->categories));
    }

    public function test_the_next_opening_is_reported_in_utc_across_a_dst_change(): void
    {
        // Saturday 7 March 2026 (EST, UTC-5). The next opening is Monday 9 March 09:00 EDT (UTC-4) = 13:00 UTC.
        $availability = $this->service()->compute($this->widget, $this->at('2026-03-07 15:00:00'));

        $this->assertFalse($availability->openNow);
        $this->assertSame('2026-03-09T13:00:00.000Z', $availability->nextOpenAt);
    }

    public function test_holidays_close_the_widget(): void
    {
        $config = $this->widget->config;
        $config['hours']['holidays'] = [['date' => '2026-01-12', 'label' => 'Company day']];
        $this->widget->forceFill(['config' => $config])->save();

        $availability = $this->service()->compute($this->widget->refresh(), $this->at('2026-01-12 15:00:00'));

        $this->assertFalse($availability->openNow);
        $this->assertSame('2026-01-13T14:00:00.000Z', $availability->nextOpenAt, 'Tuesday 09:00 EST');
    }

    public function test_always_online_and_always_offline_modes(): void
    {
        $this->fakePresence([$this->billing->id => 1]);
        $saturdayNight = $this->at('2026-01-11 03:00:00');

        app(UpdateWidget::class)->handle($this->widget, ['offline_mode' => 'always_online']);
        $online = $this->service()->compute($this->widget->refresh(), $saturdayNight);
        $this->assertTrue($online->openNow);
        $this->assertTrue($online->online, 'hours are ignored, presence still counts');
        $this->assertNull($online->nextOpenAt);

        app(UpdateWidget::class)->handle($this->widget, ['offline_mode' => 'always_offline']);
        $offline = $this->service()->compute($this->widget->refresh(), $this->at('2026-01-12 15:00:00'));
        $this->assertFalse($offline->openNow);
        $this->assertFalse($offline->online);
        $this->assertNull($offline->nextOpenAt);
    }

    public function test_the_hours_of_the_published_config_apply_not_the_draft(): void
    {
        $draft = $this->widget->draft_config;
        $draft['hours']['schedule'] = [['day' => 1, 'start' => '00:00', 'end' => '24:00']];
        $this->widget->forceFill(['draft_config' => $draft])->save();

        $this->assertFalse($this->service()->compute($this->widget->refresh(), $this->at('2026-01-13 01:00:00'))->openNow);

        app(PublishWidget::class)->handle($this->widget);

        $this->assertTrue($this->service()->compute($this->widget->refresh(), $this->at('2026-01-12 06:00:00'))->openNow, 'Monday 01:00 New York after publishing a 24 h Monday');
    }

    public function test_inactive_and_deleted_categories_are_left_out(): void
    {
        $this->sales->update(['is_active' => false]);

        $availability = $this->service()->compute($this->widget->refresh(), $this->at('2026-01-12 15:00:00'));

        $this->assertSame(['billing'], array_map(fn ($category): string => $category->slug, $availability->categories));
    }

    public function test_availability_is_cached_for_a_few_seconds_and_dropped_on_publish(): void
    {
        $this->travelTo($this->at('2026-01-12 15:00:00'));
        $this->fakePresence([$this->billing->id => 1]);

        $this->assertTrue($this->service()->forWidget($this->widget)->online);

        // Agents leave, but the cached answer is served for a while.
        $this->fakePresence([]);
        $this->assertTrue($this->service()->forWidget($this->widget)->online);

        $this->travel(AvailabilityService::CACHE_SECONDS - 1)->seconds();
        $this->assertTrue($this->service()->forWidget($this->widget)->online);

        $this->travel(2)->seconds();
        $this->assertFalse($this->service()->forWidget($this->widget)->online, 'expired after the cache lifetime');

        // Presence changes again; publishing busts the cache right away.
        $this->fakePresence([$this->billing->id => 1]);
        $this->assertFalse($this->service()->forWidget($this->widget)->online, 'still cached');
        app(PublishWidget::class)->handle($this->widget);
        $this->assertTrue($this->service()->forWidget($this->widget->refresh())->online);
    }

    public function test_the_cache_lifetime_is_within_the_documented_window(): void
    {
        $this->assertGreaterThanOrEqual(5, AvailabilityService::CACHE_SECONDS);
        $this->assertLessThanOrEqual(10, AvailabilityService::CACHE_SECONDS);
    }

    public function test_the_public_endpoint_serves_the_documented_shape(): void
    {
        $this->travelTo($this->at('2026-01-12 15:00:00'));
        $this->fakePresence([$this->sales->id => 1]);
        $url = '/api/v1/public/widgets/'.$this->widget->public_key.'/availability';

        $response = $this->withHeaders(['Origin' => 'https://customer.test'])->getJson($url);

        $response->assertOk()
            ->assertHeader('Access-Control-Allow-Origin', 'https://customer.test')
            ->assertHeader('Vary', 'Origin')
            ->assertExactJson(['data' => [
                'online' => true,
                'openNow' => true,
                'nextOpenAt' => null,
                'categories' => [['slug' => 'billing', 'online' => false], ['slug' => 'sales', 'online' => true]],
                'whatsapp' => ['enabled' => false],
            ]]);
        $this->assertCacheControl($response, ['public', 'max-age=5']);
        $this->assertSame([], $response->headers->getCookies());

        $etag = (string) $response->headers->get('ETag');
        $this->withHeaders(['Origin' => 'https://customer.test', 'If-None-Match' => $etag])->getJson($url)->assertStatus(304);
    }

    public function test_the_public_endpoint_applies_the_origin_rules(): void
    {
        $url = '/api/v1/public/widgets/'.$this->widget->public_key.'/availability';

        $this->withHeaders(['Origin' => 'https://evil.example'])->getJson($url)
            ->assertForbidden()
            ->assertJsonPath('error.code', 'origin_not_allowed')
            ->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->getJson($url)->assertForbidden();
        $this->withHeaders(['Origin' => 'https://customer.test'])->getJson('/api/v1/public/widgets/wk_doesnotexist0000000000/availability')
            ->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
    }
}
