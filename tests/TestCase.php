<?php

namespace Tests;

use App\Auth\Pizzasys\NatsProbe;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Http;
use Laravel\Fortify\Features;
use Tests\Support\FakeNatsProbe;

abstract class TestCase extends BaseTestCase
{
    /**
     * Tests never reach a real network: an HTTP call without a matching `Http::fake` throws, and the NATS connection
     * test is a stub (a developer's local portal on :8200 or NATS on :4222 must not change an outcome).
     */
    protected function setUp(): void
    {
        parent::setUp();

        Http::preventStrayRequests();
        $this->app->instance(NatsProbe::class, new FakeNatsProbe);
    }

    protected function skipUnlessFortifyHas(string $feature, ?string $message = null): void
    {
        if (! Features::enabled($feature)) {
            $this->markTestSkipped($message ?? "Fortify feature [{$feature}] is not enabled.");
        }
    }
}
