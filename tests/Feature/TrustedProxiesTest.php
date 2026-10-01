<?php

namespace Tests\Feature;

use App\Providers\AppServiceProvider;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class TrustedProxiesTest extends TestCase
{
    protected function tearDown(): void
    {
        TrustProxies::flushState();

        parent::tearDown();
    }

    private function clientIpBehindProxy(): string
    {
        Route::get('/_client-ip', fn (Request $request): string => (string) $request->ip());

        return $this->withServerVariables(['REMOTE_ADDR' => '10.0.0.5'])
            ->withHeaders(['X-Forwarded-For' => '203.0.113.9'])
            ->get('/_client-ip')
            ->getContent();
    }

    public function test_forwarded_headers_are_ignored_by_default(): void
    {
        $this->assertSame('10.0.0.5', $this->clientIpBehindProxy());
    }

    public function test_configured_proxies_are_trusted(): void
    {
        config(['chat.trusted_proxies' => '10.0.0.0/8']);
        $this->app->getProvider(AppServiceProvider::class)->boot();

        $this->assertSame('203.0.113.9', $this->clientIpBehindProxy());
    }
}
