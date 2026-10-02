<?php

namespace Tests\Feature\Presence;

use Illuminate\Console\Scheduling\Event as ScheduledEvent;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PresenceSweepCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_is_scheduled_every_minute_without_overlap_and_on_one_server(): void
    {
        $event = collect(app(Schedule::class)->events())
            ->first(fn (ScheduledEvent $event): bool => str_contains((string) $event->command, 'chat:presence-sweep'));

        $this->assertNotNull($event, 'chat:presence-sweep is not scheduled');
        $this->assertSame('* * * * *', $event->expression);
        $this->assertTrue($event->withoutOverlapping);
        $this->assertTrue($event->onOneServer);
    }

    public function test_it_does_nothing_when_nobody_is_online(): void
    {
        config(['presence.store' => 'database']);

        $this->artisan('chat:presence-sweep')
            ->expectsOutputToContain('Checked 0 agent(s): 0 change(s) (0 offline, 0 away, 0 online).')
            ->assertSuccessful();
    }
}
