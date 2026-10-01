<?php

namespace Tests\Support;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\AuthCapabilities;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Models\Category;
use App\Models\Widget;
use Illuminate\Testing\TestResponse;
use Mockery;
use Mockery\MockInterface;
use Tests\TestCase;

/**
 * Test helpers for the widget / catalog contexts.
 *
 * @mixin TestCase
 */
trait WidgetFixtures
{
    /**
     * An enabled widget with the given allowed hosts and categories (default: one active category).
     *
     * @param  list<string>  $domains
     * @param  array<string, mixed>  $attributes
     */
    protected function enabledWidget(array $domains = ['customer.test'], array $attributes = [], ?Category $category = null): Widget
    {
        $widget = Widget::factory()->enabled()->withDomains($domains)->create($attributes);
        $category ??= Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $widget->categories()->attach($category->id, ['sort_order' => 0]);

        return $widget;
    }

    /**
     * Pretend these agent counts per category id are online.
     *
     * @param  array<int, int>  $counts
     */
    protected function fakePresence(array $counts): void
    {
        $this->app->instance(PresenceReader::class, new class($counts) implements PresenceReader
        {
            /**
             * @param  array<int, int>  $counts
             */
            public function __construct(private array $counts) {}

            public function onlineAgentsByCategory(array $categoryIds, ?array $statuses = null): array
            {
                return array_intersect_key($this->counts, array_flip($categoryIds));
            }
        });
    }

    /**
     * Mint an HS256 identity token the way the documented snippets do.
     *
     * @param  array<string, mixed>  $claims
     * @param  array<string, mixed>  $header
     */
    protected function mintIdentityToken(array $claims, string $secret, array $header = ['alg' => 'HS256', 'typ' => 'JWT'], ?string $algorithm = 'sha256'): string
    {
        $encode = static fn (string $data): string => rtrim(strtr(base64_encode($data), '+/', '-_'), '=');

        $head = $encode((string) json_encode($header));
        $body = $encode((string) json_encode($claims));
        $signature = $algorithm === null ? '' : $encode(hash_hmac($algorithm, $head.'.'.$body, $secret, true));

        return $head.'.'.$body.'.'.$signature;
    }

    /**
     * Assert a response's Cache-Control carries exactly these directives (Symfony normalises their order).
     *
     * @param  list<string>  $directives
     */
    protected function assertCacheControl(TestResponse $response, array $directives): void
    {
        $actual = array_map('trim', explode(',', (string) $response->headers->get('Cache-Control')));
        sort($actual);
        sort($directives);

        $this->assertSame($directives, $actual, 'Cache-Control: '.$response->headers->get('Cache-Control'));
    }

    /**
     * The mode an installed instance has after the wizard: `auth.mode = fortify` is STORED. (AuthModeGuard refuses to guess
     * when the setting is missing on an installed instance, so tests that manage staff must store it.)
     */
    protected function useFortifyMode(): void
    {
        settings()->set('auth.mode', 'fortify');
    }

    /**
     * Switch the installation to pizzasys mode (auth.mode = pizzasys) with a stub driver that vouches for every session.
     */
    protected function usePizzasysMode(): void
    {
        /** @var MockInterface&AuthDriver $driver */
        $driver = Mockery::mock(AuthDriver::class);
        $driver->shouldReceive('key')->andReturn('pizzasys');
        $driver->shouldReceive('capabilities')->andReturn(new AuthCapabilities(false, false, false, false, 'https://portal.example'));
        $driver->shouldReceive('validateSession')->andReturn(SessionVerdict::Fresh);

        settings()->set('auth.mode', 'pizzasys');
        app(AuthModeManager::class)->extend('pizzasys', fn () => $driver);
    }
}
