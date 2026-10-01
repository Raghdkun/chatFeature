<?php

namespace Tests\Support;

use App\Support\Network\HostResolver;

/**
 * DNS for tests: every name resolves to one public address unless mapped otherwise, and nothing touches a network.
 *
 *   $this->app->instance(HostResolver::class, new FakeHostResolver(['rebinding.test' => ['10.0.0.5']]));
 */
final class FakeHostResolver implements HostResolver
{
    /** A public address (the documentation example.com one) for every unmapped name. */
    public const PUBLIC_ADDRESS = '93.184.216.34';

    /** @var list<string> every name that was looked up, in order */
    public array $lookups = [];

    /**
     * @param  array<string, list<string>>  $map
     */
    public function __construct(public array $map = []) {}

    public function resolve(string $host): array
    {
        $this->lookups[] = $host;

        return $this->map[$host] ?? [self::PUBLIC_ADDRESS];
    }
}
