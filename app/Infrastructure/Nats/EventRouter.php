<?php

namespace App\Infrastructure\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\Handlers\DeactivateIdentityHandler;
use App\Infrastructure\Nats\Handlers\FlushAllHandler;
use App\Infrastructure\Nats\Handlers\FlushIdentityHandler;
use App\Infrastructure\Nats\Handlers\Handler;
use App\Infrastructure\Nats\Handlers\NoopHandler;

/**
 * Maps the CloudEvent `type` (without the `auth.v1.` prefix) to a Handler. Patterns are exact names or a
 * trailing wildcard (`user.role.*`); an exact name beats a wildcard, a longer wildcard beats a shorter one.
 * Nothing is ever read from `user.updated.changed_fields` (its `from` side is unreliable and leaks a hash).
 *
 * | pattern                                                   | action                                        |
 * |-----------------------------------------------------------|-----------------------------------------------|
 * | user.deleted                                              | deactivateExternalId (flushAll w/o user id)   |
 * | user.created, user.updated, user.role.*, user.permission.*| flushForExternalId (flushAll w/o user id)     |
 * | assignment.user_role_store.*                              | flushForExternalId (flushAll w/o user id)     |
 * | role.updated|deleted, permission.updated|deleted         | flushAll                                      |
 * | assignment.role_permission.*, assignment.role_hierarchy.* | flushAll                                      |
 * | store.*                                                   | flushAll                                      |
 * | role.created, permission.created                          | nothing (nobody holds them yet)               |
 * | anything else                                             | acked and counted as unknown                  |
 *
 * Other contexts add routes without touching this class:
 * `$this->app->afterResolving(EventRouter::class, fn (EventRouter $router) => $router->register('foo.*', new FooHandler))`.
 */
final class EventRouter
{
    /** @var array<string, Handler> */
    private array $exact = [];

    /** @var array<string, Handler> keyed by the prefix including its trailing dot, e.g. `user.role.` */
    private array $prefixes = [];

    public function __construct(IdentityInvalidator $invalidator)
    {
        $deactivate = new DeactivateIdentityHandler($invalidator);
        $flushUser = new FlushIdentityHandler($invalidator);
        $flushAll = new FlushAllHandler($invalidator);
        $noop = new NoopHandler;

        $this->register('user.deleted', $deactivate);

        foreach (['user.created', 'user.updated', 'user.role.*', 'user.permission.*', 'assignment.user_role_store.*'] as $pattern) {
            $this->register($pattern, $flushUser);
        }

        foreach ([
            'role.updated', 'role.deleted', 'permission.updated', 'permission.deleted',
            'assignment.role_permission.*', 'assignment.role_hierarchy.*', 'store.*',
        ] as $pattern) {
            $this->register($pattern, $flushAll);
        }

        $this->register('role.created', $noop);
        $this->register('permission.created', $noop);
    }

    /**
     * Plug in a handler for an event name (`foo.bar`) or a wildcard (`foo.*`). A later registration replaces an
     * earlier one for the same pattern.
     */
    public function register(string $pattern, Handler $handler): static
    {
        if (str_ends_with($pattern, '.*')) {
            $this->prefixes[substr($pattern, 0, -1)] = $handler;
        } else {
            $this->exact[$pattern] = $handler;
        }

        return $this;
    }

    /**
     * The handler for this event, or null when it is not a known `auth.v1.` event (acked and counted as unknown).
     */
    public function resolve(CloudEvent $event): ?Handler
    {
        if (! $event->isAuthV1()) {
            return null;
        }

        $name = $event->name();

        if (isset($this->exact[$name])) {
            return $this->exact[$name];
        }

        $match = null;

        foreach ($this->prefixes as $prefix => $handler) {
            if (str_starts_with($name, $prefix) && strlen($name) > strlen($prefix) && ($match === null || strlen($prefix) > strlen($match))) {
                $match = $prefix;
            }
        }

        return $match === null ? null : $this->prefixes[$match];
    }
}
