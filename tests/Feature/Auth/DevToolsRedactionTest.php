<?php

namespace Tests\Feature\Auth;

use Tests\TestCase;

/**
 * Inertia's local DevTools write request bodies to disk: the Auth Portal tokens typed into the wizard and Settings > Auth
 * must be redacted there like passwords are.
 */
class DevToolsRedactionTest extends TestCase
{
    public function test_portal_secrets_are_redacted_next_to_the_default_keys(): void
    {
        $keys = (array) config('inertia.devtools.redact.keys');

        foreach (['password', 'token', 'service_token', 'nats_token'] as $key) {
            $this->assertContains($key, $keys);
        }
    }
}
