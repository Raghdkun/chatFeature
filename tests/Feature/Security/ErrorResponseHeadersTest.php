<?php

namespace Tests\Feature\Security;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** Machine-facing ERROR answers carry the same hardening headers as the successful ones (docs/security.md). */
class ErrorResponseHeadersTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_a_401_a_404_and_a_405_of_the_api_are_hardened(): void
    {
        foreach ([
            $this->getJson('/api/v1/me/notification-settings'),
            $this->getJson('/api/v1/no-such-route'),
            $this->postJson('/api/v1/me/notification-settings'),
        ] as $response) {
            $this->assertContains($response->getStatusCode(), [401, 404, 405]);
            $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'), (string) $response->getStatusCode());
            $this->assertSame('no-referrer', $response->headers->get('Referrer-Policy'), (string) $response->getStatusCode());
        }
    }

    public function test_an_unknown_page_is_not_sniffed_and_keeps_the_pages_own_policy(): void
    {
        $response = $this->get('/no-such-page');

        $response->assertNotFound();
        $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));
        $this->assertNotSame('no-referrer', $response->headers->get('Referrer-Policy'), 'the dashboard keeps its own referrer policy');
    }
}
