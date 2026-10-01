<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;
use App\Infrastructure\Nats\EventProcessor;
use App\Models\ProcessedEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\Support\Nats\NatsFixtures;
use Tests\Support\Nats\RecordingIdentityInvalidator;
use Tests\TestCase;

class EventProcessorTest extends TestCase
{
    use RefreshDatabase;

    private RecordingIdentityInvalidator $invalidator;

    private EventProcessor $processor;

    protected function setUp(): void
    {
        parent::setUp();

        $this->invalidator = new RecordingIdentityInvalidator;
        $this->app->instance(IdentityInvalidator::class, $this->invalidator);
        $this->processor = $this->app->make(EventProcessor::class);
    }

    public function test_it_dispatches_and_records_the_envelope_id_with_its_outcome(): void
    {
        $event = CloudEvent::fromJson(NatsFixtures::json('user.deleted'));

        $outcome = $this->processor->process($event);

        $this->assertSame(EventOutcome::DeactivatedUser, $outcome);
        $this->assertSame([['deactivateExternalId', '10']], $this->invalidator->calls);

        $row = ProcessedEvent::query()->findOrFail($event->dedupeKey());
        $this->assertSame('auth.v1.user.deleted', $row->type);
        $this->assertSame('auth.v1.user.deleted', $row->subject);
        $this->assertSame('deactivate_user', $row->outcome);
        $this->assertNotNull($row->processed_at);
    }

    public function test_replaying_the_same_envelope_id_is_skipped_without_side_effects(): void
    {
        $json = NatsFixtures::json('user.role.synced');

        $first = $this->processor->process(CloudEvent::fromJson($json));
        $second = $this->processor->process(CloudEvent::fromJson($json));
        $third = $this->processor->process(CloudEvent::fromJson($json));

        $this->assertSame(EventOutcome::FlushedUser, $first);
        $this->assertSame(EventOutcome::Duplicate, $second);
        $this->assertSame(EventOutcome::Duplicate, $third);
        $this->assertSame([['flushForExternalId', '10']], $this->invalidator->calls);
        $this->assertSame(1, ProcessedEvent::query()->count());
    }

    public function test_the_id_is_case_insensitive_and_a_new_id_is_a_new_event(): void
    {
        $envelope = NatsFixtures::envelope('user.updated');

        $this->processor->process(CloudEvent::fromJson(json_encode($envelope)));
        $lower = $this->processor->process(CloudEvent::fromJson(json_encode([...$envelope, 'id' => strtolower($envelope['id'])])));
        $fresh = $this->processor->process(CloudEvent::fromJson(json_encode([...$envelope, 'id' => NatsFixtures::ulid()])));

        $this->assertSame(EventOutcome::Duplicate, $lower);
        $this->assertSame(EventOutcome::FlushedUser, $fresh);
        $this->assertCount(2, $this->invalidator->calls);
    }

    public function test_ids_that_are_not_ulids_still_deduplicate(): void
    {
        $json = json_encode([...NatsFixtures::envelope('role.deleted'), 'id' => '3f2b8c1e-7d4a-4c55-9a0e-1b2c3d4e5f60']);

        $this->assertSame(EventOutcome::FlushedAll, $this->processor->process(CloudEvent::fromJson($json)));
        $this->assertSame(EventOutcome::Duplicate, $this->processor->process(CloudEvent::fromJson($json)));
        $this->assertSame([['flushAll', null]], $this->invalidator->calls);
    }

    public function test_a_failing_handler_rolls_the_claim_back_so_the_redelivery_is_processed(): void
    {
        $event = CloudEvent::fromJson(NatsFixtures::json('user.deleted'));
        $failures = 1;
        $this->invalidator->beforeCall = function () use (&$failures): void {
            if ($failures-- > 0) {
                throw new RuntimeException('database went away');
            }
        };

        try {
            $this->processor->process($event);
            $this->fail('The handler failure must propagate so the message is not acked.');
        } catch (RuntimeException $exception) {
            $this->assertSame('database went away', $exception->getMessage());
        }

        $this->assertSame(0, ProcessedEvent::query()->count(), 'nothing is recorded for a failed event');
        $this->assertSame([], $this->invalidator->calls);

        $this->assertSame(EventOutcome::DeactivatedUser, $this->processor->process($event));
        $this->assertSame([['deactivateExternalId', '10']], $this->invalidator->calls);
        $this->assertSame(1, ProcessedEvent::query()->count());
    }

    public function test_unknown_types_are_recorded_so_they_are_counted_but_never_dispatched(): void
    {
        $json = json_encode([...NatsFixtures::envelope('user.created'), 'id' => NatsFixtures::ulid(), 'type' => 'auth.v1.widget.exploded', 'subject' => 'auth.v1.widget.exploded']);

        $outcome = $this->processor->process(CloudEvent::fromJson($json));

        $this->assertSame(EventOutcome::Unknown, $outcome);
        $this->assertSame([], $this->invalidator->calls);
        $this->assertSame(1, ProcessedEvent::query()->where('outcome', 'unknown')->count());
    }

    public function test_pruning_removes_only_rows_past_the_retention_window(): void
    {
        $this->processor->process(CloudEvent::fromJson(NatsFixtures::json('user.deleted')));
        $this->processor->process(CloudEvent::fromJson(NatsFixtures::json('role.deleted')));
        ProcessedEvent::query()->where('type', 'auth.v1.user.deleted')->update(['processed_at' => now()->subDays(31)]);
        ProcessedEvent::query()->where('type', 'auth.v1.role.deleted')->update(['processed_at' => now()->subDays(29)]);

        $this->assertSame(1, ProcessedEvent::pruneOlderThan(30));

        $this->assertSame(['auth.v1.role.deleted'], ProcessedEvent::query()->pluck('type')->all());
    }

    public function test_the_prune_command_uses_the_retention_config_or_an_explicit_day_count(): void
    {
        $this->processor->process(CloudEvent::fromJson(NatsFixtures::json('user.deleted')));
        $this->processor->process(CloudEvent::fromJson(NatsFixtures::json('role.deleted')));
        ProcessedEvent::query()->where('type', 'auth.v1.user.deleted')->update(['processed_at' => now()->subDays(10)]);
        ProcessedEvent::query()->where('type', 'auth.v1.role.deleted')->update(['processed_at' => now()->subDays(40)]);

        $this->artisan('chat:auth:prune-events')->expectsOutputToContain('Pruned 1 processed event(s) older than 30 day(s)')->assertExitCode(0);
        $this->assertSame(1, ProcessedEvent::query()->count());

        $this->artisan('chat:auth:prune-events', ['--days' => 5])->expectsOutputToContain('Pruned 1')->assertExitCode(0);
        $this->assertSame(0, ProcessedEvent::query()->count());

        $this->artisan('chat:auth:prune-events', ['--days' => 0])->assertExitCode(2);
    }
}
