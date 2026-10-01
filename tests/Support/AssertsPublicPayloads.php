<?php

namespace Tests\Support;

use Tests\TestCase;

/**
 * Asserts that API payloads never expose integer primary keys (public ids are ULIDs / widget keys only).
 *
 * @mixin TestCase
 */
trait AssertsPublicPayloads
{
    /**
     * @param  array<array-key, mixed>  $payload
     */
    protected function assertNoIntegerIds(array $payload, string $path = '$'): void
    {
        foreach ($payload as $key => $value) {
            $here = $path.'.'.$key;

            if (is_string($key) && ($key === 'id' || str_ends_with($key, '_id') || str_ends_with($key, 'Id'))) {
                $this->assertFalse(is_int($value), "Integer id leaked at {$here}");
            }

            if (is_array($value)) {
                $this->assertNoIntegerIds($value, $here);
            }
        }
    }

    /**
     * @param  array<array-key, mixed>  $payload
     */
    protected function assertNoSecrets(array $payload): void
    {
        $json = (string) json_encode($payload);

        foreach (['identity_secret_encrypted', 'identity_secret', 'draft_config', 'password'] as $needle) {
            $this->assertStringNotContainsString('"'.$needle.'"', $json, "{$needle} must not be part of the payload");
        }
    }
}
