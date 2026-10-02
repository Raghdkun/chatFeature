<?php

namespace Tests;

use App\Auth\Pizzasys\NatsProbe;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Support\Network\HostResolver;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Http;
use Laravel\Fortify\Features;
use Tests\Support\FakeHostResolver;
use Tests\Support\FakeNatsProbe;
use Tests\Support\FakeOpenWaClient;
use Tests\Support\FakeWaMediaUrls;

abstract class TestCase extends BaseTestCase
{
    /**
     * Tests never reach a real network: an HTTP call without a matching `Http::fake` throws, DNS is a stub (every name
     * resolves to one public address), the NATS connection test is a stub (a developer's local portal on :8200 or
     * NATS on :4222 must not change an outcome) and OpenWA is an in-memory fake (`Tests\Support\FakeOpenWaClient`, reachable with
     * `WhatsAppFixtures::openWa()`), with media URLs that need no signed route.
     */
    protected function setUp(): void
    {
        parent::setUp();

        Http::preventStrayRequests();
        $this->app->instance(HostResolver::class, new FakeHostResolver);
        $this->app->instance(NatsProbe::class, new FakeNatsProbe);
        $this->app->instance(OpenWaClient::class, new FakeOpenWaClient);
        $this->app->instance(WaMediaUrls::class, new FakeWaMediaUrls);

        // Chat tests start many chats / offline tickets from one address in seconds; the anti-automation budgets of those two calls
        // (tests/Feature/Chat/Api/ChatAbuseLimitsApiTest.php) set their own values.
        config([
            'chat.rate_limits.start_per_widget_network' => 10000,
            'chat.rate_limits.start_per_widget' => 10000,
            'chat.rate_limits.offline_per_widget_network' => 10000,
            'chat.rate_limits.offline_per_widget' => 10000,
        ]);
    }

    protected function skipUnlessFortifyHas(string $feature, ?string $message = null): void
    {
        if (! Features::enabled($feature)) {
            $this->markTestSkipped($message ?? "Fortify feature [{$feature}] is not enabled.");
        }
    }
}
