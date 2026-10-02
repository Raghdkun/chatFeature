<?php

namespace Tests\Support;

use Illuminate\Contracts\Hashing\Hasher;

/**
 * Wraps the real hasher and counts the password checks, so a test can prove that a sign-in that has no account to check still spends the
 * time of one check (`Hash::swap(new CountingHasher(app('hash')))`, before the auth guard is resolved).
 */
final class CountingHasher implements Hasher
{
    public int $checks = 0;

    public function __construct(private readonly Hasher $inner) {}

    public function info($hashedValue)
    {
        return $this->inner->info($hashedValue);
    }

    public function make($value, array $options = [])
    {
        return $this->inner->make($value, $options);
    }

    public function check($value, $hashedValue, array $options = [])
    {
        $this->checks++;

        return $this->inner->check($value, $hashedValue, $options);
    }

    public function needsRehash($hashedValue, array $options = [])
    {
        return $this->inner->needsRehash($hashedValue, $options);
    }

    /**
     * @param  array<int, mixed>  $arguments
     */
    public function __call(string $method, array $arguments): mixed
    {
        return $this->inner->{$method}(...$arguments);
    }
}
