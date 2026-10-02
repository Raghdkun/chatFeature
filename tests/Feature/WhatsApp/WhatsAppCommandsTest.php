<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * `whatsapp:reconcile-sessions` (every minute: fixes what lost webhooks missed, fails replies nobody confirmed) and `whatsapp:prune` (daily).
 */
class WhatsAppCommandsTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures;

    public function test_both_commands_are_scheduled(): void
    {
        $events = collect(app(Schedule::class)->events());

        $reconcile = $events->first(fn ($event): bool => str_contains((string) $event->command, 'whatsapp:reconcile-sessions'));
        $prune = $events->first(fn ($event): bool => str_contains((string) $event->command, 'whatsapp:prune'));

        $this->assertNotNull($reconcile);
        $this->assertSame('* * * * *', $reconcile->expression);
        $this->assertTrue($reconcile->withoutOverlapping);
        $this->assertNotNull($prune);
        $this->assertSame('15 4 * * *', $prune->expression);
    }

    // ---- reconcile ---------------------------------------------------------------------------------------------------------

    public function test_a_lost_webhook_is_repaired_from_what_openwa_reports(): void
    {
        $openWa = $this->openWa();
        $remote = $openWa->makeSession('00000000-0000-4000-8000-0000000000f1', SessionStatus::Ready, 'support-main');
        $openWa->withSession($remote);
        // The app thinks it is still starting: the `ready` webhook never arrived.
        $session = WhatsAppSession::factory()->starting()->create(['name' => 'support-main', 'openwa_session_id' => $remote->id]);

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful()->expectsOutputToContain('Checked 1 session(s), 1 changed');

        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertSame('+4915100000000', $session->phone_e164);
    }

    public function test_only_sessions_that_should_be_doing_something_are_asked(): void
    {
        $this->openWa()->withSession($this->openWa()->makeSession('00000000-0000-4000-8000-0000000000f2', SessionStatus::Ready, 'a'));
        WhatsAppSession::factory()->create(['openwa_session_id' => '00000000-0000-4000-8000-0000000000f2']);      // created: nothing to reconcile
        WhatsAppSession::factory()->ready()->create(['openwa_session_id' => null]);                                // never reached OpenWA
        WhatsAppSession::factory()->ready()->create(['openwa_session_id' => '00000000-0000-4000-8000-0000000000f3'])->delete(); // deleted

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful()->expectsOutputToContain('Checked 0 session(s)');

        $this->openWa()->assertNotCalled('getSession');
    }

    public function test_a_session_openwa_lost_is_marked_failed(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful();

        $this->assertSame(SessionStatus::Failed, $session->refresh()->status);
    }

    public function test_an_unreachable_openwa_stops_the_run_after_the_first_failure_and_logs_once(): void
    {
        Log::spy();
        WhatsAppSession::factory()->ready()->count(3)->create();
        $this->openWa()->willThrow('getSession', new OpenWaUnavailable('down'), null);

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful()->expectsOutputToContain('could not be reached');
        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful();

        $this->assertCount(2, $this->openWa()->calls('getSession'), 'one attempt per run, not one per session');
        Log::shouldHaveReceived('warning')->once();
        $this->assertSame(3, WhatsAppSession::query()->where('status', 'ready')->count(), 'nothing is changed on a guess');
    }

    public function test_a_refused_key_also_stops_the_run(): void
    {
        WhatsAppSession::factory()->ready()->count(2)->create();
        $this->openWa()->willThrow('getSession', new OpenWaRejected('unauthorized', 401, 'Invalid API key'), null);

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful();

        $this->assertCount(1, $this->openWa()->calls('getSession'));
    }

    public function test_openwas_throttle_stops_the_run_quietly_without_calling_it_a_fault(): void
    {
        Log::spy();
        WhatsAppSession::factory()->ready()->count(2)->create();
        $this->openWa()->willThrow('getSession', new OpenWaRejected('rate_limited', 429, 'ThrottlerException: Too Many Requests'), null);

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful()->doesntExpectOutputToContain('could not be reached');

        $this->assertCount(1, $this->openWa()->calls('getSession'));
        Log::shouldNotHaveReceived('warning');
    }

    public function test_replies_nobody_confirmed_are_failed_after_the_wait_and_give_their_slot_back(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $chat = WaChat::factory()->for($session, 'session')->create();
        $old = WaMessage::factory()->for($chat, 'chat')->outbound()->pending()->create(['created_at' => now()->subMinutes(45)]);
        $recent = WaMessage::factory()->for($chat, 'chat')->outbound()->pending()->create(['created_at' => now()->subMinutes(5)]);
        $confirmed = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['status' => WaMessageStatus::Sent, 'created_at' => now()->subMinutes(45)]);
        app(SendCounter::class)->reserve($session, $old->created_at);

        $this->artisan('whatsapp:reconcile-sessions')->assertSuccessful()->expectsOutputToContain('1 unconfirmed reply(ies) failed');

        $old->refresh();
        $this->assertSame(WaMessageStatus::Failed, $old->status);
        $this->assertStringContainsString('never confirmed', (string) $old->error);
        $this->assertSame(WaMessageStatus::Pending, $recent->refresh()->status);
        $this->assertSame(WaMessageStatus::Sent, $confirmed->refresh()->status);
        $this->assertSame(0, app(SendCounter::class)->used($session, $old->created_at));
    }

    // ---- prune -------------------------------------------------------------------------------------------------------------

    public function test_the_prune_removes_old_ledger_rows_and_expired_unused_tickets_only(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $old = WaWebhookDelivery::factory()->create(['session_id' => $session->id, 'received_at' => now()->subDays(31)]);
        $fresh = WaWebhookDelivery::factory()->create(['session_id' => $session->id, 'received_at' => now()->subDays(29)]);
        $chat = WaChat::factory()->for($session, 'session')->create();
        $widget = Widget::factory()->create();
        $expired = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'expires_at' => now()->subDays(2)]);
        $recentlyExpired = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'expires_at' => now()->subHours(2)]);
        $live = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'expires_at' => now()->addDay()]);
        $consumed = WaHandoffTicket::factory()->consumed($chat)->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'expires_at' => now()->subDays(40)]);
        $message = WaMessage::factory()->for($chat, 'chat')->inbound()->create();

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('Deleted 1 webhook delivery(ies), 1 expired ticket(s)');

        $this->assertFalse(WaWebhookDelivery::query()->whereKey($old->id)->exists());
        $this->assertTrue(WaWebhookDelivery::query()->whereKey($fresh->id)->exists());
        $this->assertFalse(WaHandoffTicket::query()->whereKey($expired->id)->exists());
        $this->assertTrue(WaHandoffTicket::query()->whereKey($recentlyExpired->id)->exists(), 'a ticket that expired a moment ago is kept for a day');
        $this->assertTrue(WaHandoffTicket::query()->whereKey($live->id)->exists());
        $this->assertTrue(WaHandoffTicket::query()->whereKey($consumed->id)->exists(), 'a ticket that linked a chat is the record of where it came from');
        $this->assertTrue(WaMessage::query()->whereKey($message->id)->exists(), 'messages are never pruned');
        $this->assertTrue(WaChat::query()->whereKey($chat->id)->exists());
    }

    public function test_options_change_the_retention(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        WaWebhookDelivery::factory()->create(['session_id' => $session->id, 'received_at' => now()->subDays(8)]);

        $this->artisan('whatsapp:prune', ['--deliveries-days' => 7])->assertSuccessful()->expectsOutputToContain('Deleted 1 webhook delivery(ies)');
    }

    public function test_orphan_media_older_than_a_day_is_deleted_and_referenced_or_fresh_files_stay(): void
    {
        Storage::fake('local');
        $disk = Storage::disk('local');
        $chat = WaChat::factory()->for(WhatsAppSession::factory()->ready(), 'session')->create();
        foreach (['kept', 'orphan-old', 'orphan-fresh'] as $name) {
            $disk->put('whatsapp/media/2026/10/'.$name.'.jpg', 'x');
        }

        WaMessage::factory()->for($chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/kept.jpg']);
        touch($disk->path('whatsapp/media/2026/10/kept.jpg'), now()->subDays(3)->getTimestamp());
        touch($disk->path('whatsapp/media/2026/10/orphan-old.jpg'), now()->subDays(3)->getTimestamp());

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('1 orphan file(s)');

        $this->assertTrue($disk->exists('whatsapp/media/2026/10/kept.jpg'));
        $this->assertFalse($disk->exists('whatsapp/media/2026/10/orphan-old.jpg'));
        $this->assertTrue($disk->exists('whatsapp/media/2026/10/orphan-fresh.jpg'), 'a file written a moment ago may belong to a row that is about to be saved');
    }
}
