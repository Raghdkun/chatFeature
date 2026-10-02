<?php

use App\Console\Commands\ChatCloseIdle;
use App\Console\Commands\ChatCloseUnrated;
use App\Console\Commands\ChatExpireQueued;
use App\Console\Commands\ChatOfferWaves;
use App\Console\Commands\ChatPresenceSweep;
use App\Console\Commands\ChatPruneVisitorSessions;
use App\Console\Commands\ChatRealtimeSweep;
use App\Console\Commands\WhatsAppPrune;
use App\Console\Commands\WhatsAppReconcileSessions;
use App\Console\Commands\WhatsAppReplayDeliveries;
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
// P7: closes the websockets of expired visitor tokens and of staff who lost a conversation; repeats/retries earlier cut-offs (docs/realtime.md, "Cutting a socket off").
Schedule::command(ChatRealtimeSweep::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(ChatPruneVisitorSessions::class)->dailyAt('03:45')->withoutOverlapping(60)->onOneServer();

/*
|--------------------------------------------------------------------------
| WhatsApp (P6)
|--------------------------------------------------------------------------
| `whatsapp:reconcile-sessions` asks OpenWA what it knows about every session (a lost webhook only delays the dashboard by a minute) and
| fails replies nobody confirmed; `whatsapp:replay-deliveries` queues accepted deliveries again whose job was lost or that failed; `whatsapp:prune` keeps the ledger, the tickets, the media and the raw data within their retention. Same scheduler and worker as the chat.
*/
Schedule::command(WhatsAppReconcileSessions::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(WhatsAppReplayDeliveries::class)->everyFiveMinutes()->withoutOverlapping(10)->onOneServer();
Schedule::command(WhatsAppPrune::class)->dailyAt('04:15')->withoutOverlapping(60)->onOneServer();
