<?php

use App\Console\Commands\ChatCloseIdle;
use App\Console\Commands\ChatCloseUnrated;
use App\Console\Commands\ChatExpireQueued;
use App\Console\Commands\ChatOfferWaves;
use App\Console\Commands\ChatPruneVisitorSessions;
use App\Console\Commands\WhatsAppPrune;
use App\Console\Commands\WhatsAppReconcileSessions;
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
Schedule::command(ChatPruneVisitorSessions::class)->dailyAt('03:45')->withoutOverlapping(60)->onOneServer();

/*
|--------------------------------------------------------------------------
| WhatsApp (P6)
|--------------------------------------------------------------------------
| `whatsapp:reconcile-sessions` asks OpenWA what it knows about every session (a lost webhook only delays the dashboard by a minute) and
| fails replies nobody confirmed; `whatsapp:prune` keeps the ledger, the tickets and the media folder small. Same scheduler and worker as the chat.
*/
Schedule::command(WhatsAppReconcileSessions::class)->everyMinute()->withoutOverlapping(5)->onOneServer();
Schedule::command(WhatsAppPrune::class)->dailyAt('04:15')->withoutOverlapping(60)->onOneServer();
