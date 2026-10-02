<?php

use App\Console\Commands\ChatCloseIdle;
use App\Console\Commands\ChatCloseUnrated;
use App\Console\Commands\ChatExpireQueued;
use App\Console\Commands\ChatOfferWaves;
use App\Console\Commands\ChatPresenceSweep;
use App\Console\Commands\ChatPruneVisitorSessions;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

/*
|--------------------------------------------------------------------------
| Live chat timers (P4)
|--------------------------------------------------------------------------
| The guarded UPDATE of each sweep is the source of truth, so a missed minute only delays a transition. Run the scheduler
| (`php artisan schedule:work`, or cron `* * * * * php artisan schedule:run`) next to the queue worker; `onOneServer` needs a shared
| cache (Redis) when several app servers run it.
*/
Schedule::command(ChatExpireQueued::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(ChatOfferWaves::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(ChatCloseIdle::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(ChatCloseUnrated::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
// P5: silent agents go offline, idle automatic ones away (docs/realtime.md, "Presence").
Schedule::command(ChatPresenceSweep::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(ChatPruneVisitorSessions::class)->dailyAt('03:45')->withoutOverlapping(60)->onOneServer();
