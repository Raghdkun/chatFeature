<?php

namespace Tests\Unit\Nats;

use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;
use App\Infrastructure\Nats\EventRouter;
use App\Infrastructure\Nats\Handlers\Handler;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Tests\Support\Nats\NatsFixtures;
use Tests\Support\Nats\RecordingIdentityInvalidator;

class EventRouterTest extends TestCase
{
    /**
     * The binding contract with the IdentityInvalidator (docs/contracts/auth-pizzasys.md): for the first recorded
     * event of each of the 27 subjects, which method is called with which id (no calls = nothing to invalidate).
     *
     * @return array<string, array{0: string, 1: list<array{string, string|null}>, 2: EventOutcome}>
     */
    public static function matrix(): array
    {
        $flushAll = [['flushAll', null]];
        $user10 = [['flushForExternalId', '10']];

        return [
            'user.created' => ['user.created', [['flushForExternalId', '11']], EventOutcome::FlushedUser],
            'user.updated' => ['user.updated', $user10, EventOutcome::FlushedUser],
            'user.deleted' => ['user.deleted', [['deactivateExternalId', '10']], EventOutcome::DeactivatedUser],
            'user.role.assigned' => ['user.role.assigned', $user10, EventOutcome::FlushedUser],
            'user.role.removed' => ['user.role.removed', $user10, EventOutcome::FlushedUser],
            'user.role.synced' => ['user.role.synced', $user10, EventOutcome::FlushedUser],
            'user.permission.granted' => ['user.permission.granted', $user10, EventOutcome::FlushedUser],
            'user.permission.revoked' => ['user.permission.revoked', $user10, EventOutcome::FlushedUser],
            'user.permission.synced' => ['user.permission.synced', $user10, EventOutcome::FlushedUser],
            'permission.created' => ['permission.created', [], EventOutcome::Noop],
            'permission.updated' => ['permission.updated', $flushAll, EventOutcome::FlushedAll],
            'permission.deleted' => ['permission.deleted', $flushAll, EventOutcome::FlushedAll],
            'role.created' => ['role.created', [], EventOutcome::Noop],
            'role.updated' => ['role.updated', $flushAll, EventOutcome::FlushedAll],
            'role.deleted' => ['role.deleted', $flushAll, EventOutcome::FlushedAll],
            'store.created' => ['store.created', $flushAll, EventOutcome::FlushedAll],
            'store.updated' => ['store.updated', $flushAll, EventOutcome::FlushedAll],
            'store.deleted' => ['store.deleted', $flushAll, EventOutcome::FlushedAll],
            'assignment.role_permission.assigned' => ['assignment.role_permission.assigned', $flushAll, EventOutcome::FlushedAll],
            'assignment.role_permission.revoked' => ['assignment.role_permission.revoked', $flushAll, EventOutcome::FlushedAll],
            'assignment.role_permission.synced' => ['assignment.role_permission.synced', $flushAll, EventOutcome::FlushedAll],
            'assignment.user_role_store.assigned' => ['assignment.user_role_store.assigned', $user10, EventOutcome::FlushedUser],
            'assignment.user_role_store.toggled' => ['assignment.user_role_store.toggled', $user10, EventOutcome::FlushedUser],
            'assignment.user_role_store.removed' => ['assignment.user_role_store.removed', $user10, EventOutcome::FlushedUser],
            'assignment.user_role_store.bulk_assigned' => ['assignment.user_role_store.bulk_assigned', $user10, EventOutcome::FlushedUser],
            'assignment.role_hierarchy.created' => ['assignment.role_hierarchy.created', $flushAll, EventOutcome::FlushedAll],
            'assignment.role_hierarchy.removed' => ['assignment.role_hierarchy.removed', $flushAll, EventOutcome::FlushedAll],
        ];
    }

    public function test_the_matrix_covers_every_subject_in_the_recorded_fixture(): void
    {
        $this->assertCount(27, self::matrix());
        $this->assertEqualsCanonicalizing(
            array_map(static fn (string $name): string => 'auth.v1.'.$name, array_keys(self::matrix())),
            NatsFixtures::types(),
        );
    }

    /**
     * @param  list<array{string, string|null}>  $expectedCalls
     */
    #[DataProvider('matrix')]
    public function test_each_subject_calls_exactly_the_expected_invalidator_method(string $type, array $expectedCalls, EventOutcome $expectedOutcome): void
    {
        $invalidator = new RecordingIdentityInvalidator;
        $router = new EventRouter($invalidator);
        $event = CloudEvent::fromJson(NatsFixtures::json($type));

        $handler = $router->resolve($event);

        $this->assertInstanceOf(Handler::class, $handler, "{$type} has no route");
        $this->assertSame($expectedOutcome, $handler->handle($event));
        $this->assertSame($expectedCalls, $invalidator->calls);
    }

    /**
     * Same events through the real publisher shape for every recorded envelope (all 34, not just the first per type).
     */
    public function test_every_recorded_envelope_is_routed_to_a_handler(): void
    {
        $invalidator = new RecordingIdentityInvalidator;
        $router = new EventRouter($invalidator);

        foreach (NatsFixtures::all() as $envelope) {
            $event = CloudEvent::fromJson(json_encode($envelope, JSON_THROW_ON_ERROR));
            $handler = $router->resolve($event);

            $this->assertNotNull($handler, $envelope['type']);
            $this->assertNotSame(EventOutcome::Unknown, $handler->handle($event));
        }
    }

    /**
     * @return array<string, array{string, string}>
     */
    public static function userScopedWithoutUser(): array
    {
        return [
            'user.created' => ['user.created', 'flushAll'],
            'user.updated' => ['user.updated', 'flushAll'],
            'user.deleted' => ['user.deleted', 'flushAll'],
            'user.role.synced' => ['user.role.synced', 'flushAll'],
            'user.permission.revoked' => ['user.permission.revoked', 'flushAll'],
            'assignment.user_role_store.toggled' => ['assignment.user_role_store.toggled', 'flushAll'],
            'assignment.user_role_store.bulk_assigned' => ['assignment.user_role_store.bulk_assigned', 'flushAll'],
        ];
    }

    #[DataProvider('userScopedWithoutUser')]
    public function test_user_scoped_events_without_a_resolvable_user_fall_back_to_flush_all(string $type, string $expectedMethod): void
    {
        $invalidator = new RecordingIdentityInvalidator;
        $router = new EventRouter($invalidator);
        $event = CloudEvent::fromJson($this->envelope('auth.v1.'.$type, ['unrelated' => 'x']));

        $router->resolve($event)?->handle($event);

        $this->assertSame([[$expectedMethod, null]], $invalidator->calls);
    }

    public function test_user_updated_never_trusts_changed_fields(): void
    {
        $invalidator = new RecordingIdentityInvalidator;
        $router = new EventRouter($invalidator);
        $event = CloudEvent::fromJson($this->envelope('auth.v1.user.updated', [
            'changed_fields' => ['email' => ['from' => 'old@example.test', 'to' => 'new@example.test'], 'user_id' => ['from' => 99, 'to' => 99]],
        ]));

        $router->resolve($event)?->handle($event);

        $this->assertSame([['flushAll', null]], $invalidator->calls);
    }

    public function test_unknown_and_foreign_types_have_no_route(): void
    {
        $router = new EventRouter(new RecordingIdentityInvalidator);

        foreach (['auth.v1.widget.exploded', 'auth.v1.user', 'auth.v1.user.role', 'auth.v2.user.deleted', 'user.deleted', 'billing.v1.user.deleted', 'auth.v1.store'] as $type) {
            $this->assertNull($router->resolve(CloudEvent::fromJson($this->envelope($type, ['user_id' => 1]))), $type);
        }
    }

    public function test_new_events_plug_in_through_a_handler(): void
    {
        $router = new EventRouter(new RecordingIdentityInvalidator);
        $seen = [];
        $handler = new class($seen) implements Handler
        {
            /** @param list<string> $seen */
            public function __construct(public array &$seen) {}

            public function handle(CloudEvent $event): EventOutcome
            {
                $this->seen[] = $event->name();

                return EventOutcome::Noop;
            }
        };

        $router->register('service.*', $handler)->register('user.deleted', $handler);

        $custom = CloudEvent::fromJson($this->envelope('auth.v1.service.token_rotated', ['user_id' => 1]));
        $replaced = CloudEvent::fromJson($this->envelope('auth.v1.user.deleted', ['user_id' => 1]));

        $this->assertSame($handler, $router->resolve($custom));
        $this->assertSame($handler, $router->resolve($replaced), 'a later registration replaces the default');
        $this->assertNotSame($handler, $router->resolve(CloudEvent::fromJson($this->envelope('auth.v1.user.updated'))));
    }

    public function test_an_exact_name_beats_a_wildcard_and_a_longer_wildcard_beats_a_shorter_one(): void
    {
        $router = new EventRouter(new RecordingIdentityInvalidator);
        $make = fn (): Handler => new class implements Handler
        {
            public function handle(CloudEvent $event): EventOutcome
            {
                return EventOutcome::Noop;
            }
        };
        [$broad, $narrow, $exact] = [$make(), $make(), $make()];

        $router->register('thing.*', $broad)->register('thing.deep.*', $narrow)->register('thing.deep.leaf', $exact);

        $this->assertSame($broad, $router->resolve(CloudEvent::fromJson($this->envelope('auth.v1.thing.other'))));
        $this->assertSame($narrow, $router->resolve(CloudEvent::fromJson($this->envelope('auth.v1.thing.deep.branch'))));
        $this->assertSame($exact, $router->resolve(CloudEvent::fromJson($this->envelope('auth.v1.thing.deep.leaf'))));
        $this->assertNull($router->resolve(CloudEvent::fromJson($this->envelope('auth.v1.thing'))), 'a wildcard needs at least one more segment');
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function envelope(string $type, array $data = []): string
    {
        return json_encode(['specversion' => '1.0', 'id' => '01M3TNCWV4NRSSY7H4131KBAZC', 'type' => $type, 'data' => $data], JSON_THROW_ON_ERROR);
    }
}
