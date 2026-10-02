<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Jobs\SendWhatsAppMessage;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Services\SendPacer;
use App\Domain\WhatsApp\Services\WebhookProcessor;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * S4: customers' WhatsApp data does not have to live for ever. The raw webhook object (debugging only) is dropped after
 * `whatsapp.raw_retention_days`, messages and chats after `whatsapp.retention_days` (0 = keep), and an administrator can erase one chat
 * for good (`DELETE /whatsapp/chats/{ulid}`: idempotent, audited without personal data, stored images included).
 */
class WhatsAppRetentionTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    private WhatsAppSession $session;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        Storage::fake('local');
        $this->admin = $this->whatsAppPeople()['admin'];
        $this->session = $this->webhookSession();
    }

    private function chat(string $chatId = '4915123456789@c.us'): WaChat
    {
        return WaChat::factory()->for($this->session, 'session')->create(['chat_id' => $chatId, 'phone_e164' => '+'.explode('@', $chatId)[0], 'push_name' => 'Anna Customer']);
    }

    // ---- raw retention -----------------------------------------------------------------------------------------------------

    public function test_the_raw_object_is_stored_by_default_and_not_at_all_with_a_retention_of_zero_days(): void
    {
        Queue::fake();
        $this->deliver($this->session, $this->messageReceived(['id' => 'false_4915123456789@c.us_RAW1', 'body' => 'kept']))->assertOk();
        (new ProcessWebhookDelivery(WaWebhookDelivery::query()->sole()->id))->handle($this->app->make(WebhookProcessor::class));
        $this->assertNotNull(WaMessage::query()->sole()->raw, 'default: 30 days');

        settings()->set('whatsapp.raw_retention_days', 0);
        $this->deliver($this->session, $this->messageReceived(['id' => 'false_4915123456789@c.us_RAW2', 'body' => 'not kept']))->assertOk();
        (new ProcessWebhookDelivery(WaWebhookDelivery::query()->latest('id')->firstOrFail()->id))->handle($this->app->make(WebhookProcessor::class));

        $this->assertNull(WaMessage::query()->where('wa_message_id', 'false_4915123456789@c.us_RAW2')->sole()->raw);
    }

    public function test_with_zero_days_a_large_image_still_keeps_the_chat_id_its_fetch_needs_and_nothing_else(): void
    {
        settings()->set('whatsapp.raw_retention_days', 0);

        $this->deliver($this->session, $this->messageReceived([
            'id' => 'false_4915123456789@s.whatsapp.net_BIG', 'type' => 'image', 'from' => '4915123456789@s.whatsapp.net', 'chatId' => '4915123456789@s.whatsapp.net',
            'body' => 'my passport', 'media' => ['mimetype' => 'image/jpeg', 'omitted' => true, 'sizeBytes' => 2_400_000],
        ]))->assertOk();

        $raw = WaMessage::query()->sole()->raw;
        $this->assertSame(['chatId' => '4915123456789@s.whatsapp.net'], $raw);
    }

    public function test_the_prune_drops_the_raw_object_after_the_retention_and_keeps_younger_ones(): void
    {
        $chat = $this->chat();
        $old = WaMessage::factory()->for($chat, 'chat')->inbound()->create(['raw' => ['body' => 'old'], 'created_at' => now()->subDays(31)]);
        $young = WaMessage::factory()->for($chat, 'chat')->inbound()->create(['raw' => ['body' => 'young'], 'created_at' => now()->subDays(29)]);

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('raw object dropped from 1 message(s)');

        $this->assertNull($old->refresh()->raw);
        $this->assertSame(['body' => 'young'], $young->refresh()->raw);
        $this->assertNotNull($old->body);
    }

    public function test_a_retention_of_zero_days_clears_every_raw_object_that_is_left(): void
    {
        settings()->set('whatsapp.raw_retention_days', 0);
        $chat = $this->chat();
        WaMessage::factory()->for($chat, 'chat')->inbound()->count(3)->create(['raw' => ['body' => 'x']]);

        $this->artisan('whatsapp:prune')->assertSuccessful();

        $this->assertSame(0, WaMessage::query()->whereNotNull('raw')->count());
    }

    public function test_the_bodies_kept_on_failed_deliveries_go_after_the_raw_retention_but_not_before_a_day(): void
    {
        $failed = fn (array $attributes) => WaWebhookDelivery::query()->create($attributes + [
            'session_id' => $this->session->id, 'event' => 'message.received', 'outcome' => WebhookOutcome::Failed, 'processed_at' => now(), 'error' => 'boom', 'body' => '{"event":"message.received"}',
        ]);
        settings()->set('whatsapp.raw_retention_days', 7);
        $old = $failed(['idempotency_key' => 'a', 'received_at' => now()->subDays(8)]);
        $young = $failed(['idempotency_key' => 'b', 'received_at' => now()->subDays(3)]);

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('body from 1 delivery(ies)');

        $this->assertNull($old->refresh()->body);
        $this->assertNotNull($young->refresh()->body, 'still waiting for its replay');

        // Even with a retention of zero days a body lives for a day: the replay needs it.
        settings()->set('whatsapp.raw_retention_days', 0);
        $fresh = $failed(['idempotency_key' => 'c', 'received_at' => now()->subHours(2)]);
        $this->artisan('whatsapp:prune')->assertSuccessful();
        $this->assertNotNull($fresh->refresh()->body);
    }

    // ---- message and chat retention ----------------------------------------------------------------------------------------

    public function test_nothing_is_deleted_without_a_retention_setting(): void
    {
        $chat = $this->chat();
        WaMessage::factory()->for($chat, 'chat')->inbound()->create(['wa_timestamp' => now()->subYears(3)]);

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('deleted 0 message(s) and 0 chat(s)');

        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(1, WaChat::query()->count());
    }

    public function test_messages_and_their_images_older_than_the_retention_are_deleted_and_so_are_the_chats_left_empty(): void
    {
        settings()->set('whatsapp.retention_days', 90);
        $disk = Storage::disk('local');
        $disk->put('whatsapp/media/2026/07/old.jpg', 'x');
        $disk->put('whatsapp/media/2026/10/new.jpg', 'x');

        $quiet = $this->chat('4915111111111@c.us');
        WaMessage::factory()->for($quiet, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/07/old.jpg', 'wa_timestamp' => now()->subDays(120)]);
        WaMessage::factory()->for($quiet, 'chat')->inbound()->count(2)->create(['wa_timestamp' => now()->subDays(100)]);
        $quiet->forceFill(['created_at' => now()->subDays(130), 'last_message_at' => now()->subDays(100)])->save();

        $mixed = $this->chat('4915122222222@c.us');
        WaMessage::factory()->for($mixed, 'chat')->inbound()->create(['wa_timestamp' => now()->subDays(95)]);
        $keptMessage = WaMessage::factory()->for($mixed, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/new.jpg', 'wa_timestamp' => now()->subDays(2)]);

        $fresh = $this->chat('4915133333333@c.us');
        WaMessage::factory()->for($fresh, 'chat')->inbound()->create(['wa_timestamp' => now()->subDay()]);

        $this->artisan('whatsapp:prune')->assertSuccessful()->expectsOutputToContain('deleted 4 message(s) and 1 chat(s)');

        $this->assertFalse(WaChat::query()->whereKey($quiet->id)->exists(), 'nothing left in it, quiet for longer than the retention');
        $this->assertTrue(WaChat::query()->whereKey($mixed->id)->exists());
        $this->assertTrue(WaChat::query()->whereKey($fresh->id)->exists());
        $this->assertSame([$keptMessage->id], WaMessage::query()->where('wa_chat_id', $mixed->id)->pluck('id')->all());
        $this->assertFalse($disk->exists('whatsapp/media/2026/07/old.jpg'), 'the file of a deleted message goes with it');
        $this->assertTrue($disk->exists('whatsapp/media/2026/10/new.jpg'));
    }

    // ---- erasing one chat --------------------------------------------------------------------------------------------------

    public function test_an_administrator_erases_a_chat_with_its_messages_and_stored_images(): void
    {
        $disk = Storage::disk('local');
        $disk->put('whatsapp/media/2026/10/a.jpg', 'x');
        $disk->put('whatsapp/media/2026/10/b.jpg', 'x');
        $chat = $this->chat();
        $other = $this->chat('4915199999999@c.us');
        WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => 'my iban is DE00 secret']);
        WaMessage::factory()->for($chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/a.jpg']);
        WaMessage::factory()->for($other, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/b.jpg']);
        $widget = Widget::factory()->create();
        $ticket = WaHandoffTicket::factory()->consumed($chat)->create(['widget_id' => $widget->id, 'session_id' => $this->session->id]);

        $this->actingAs($this->admin, 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertNoContent();

        $this->assertFalse(WaChat::query()->whereKey($chat->id)->exists());
        $this->assertSame(0, WaMessage::query()->where('wa_chat_id', $chat->id)->count());
        $this->assertFalse($disk->exists('whatsapp/media/2026/10/a.jpg'));
        $this->assertTrue($disk->exists('whatsapp/media/2026/10/b.jpg'), 'another customer\'s image is untouched');
        $this->assertSame(1, WaMessage::query()->count());
        $this->assertTrue(WaChat::query()->whereKey($other->id)->exists());
        $this->assertNull($ticket->refresh()->wa_chat_id, 'the hand-off ticket stays, no longer pointing at the erased chat');
    }

    public function test_the_erasure_is_audited_without_the_number_the_name_or_any_text(): void
    {
        $chat = $this->chat();
        WaMessage::factory()->for($chat, 'chat')->inbound()->count(3)->create(['body' => 'my iban is DE00 secret']);

        $this->actingAs($this->admin, 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertNoContent();

        $entry = AuditLog::query()->where('action', 'whatsapp.chat.deleted')->sole();
        $this->assertSame($this->admin->id, $entry->actor_id);
        $this->assertSame(['chat' => $chat->ulid, 'messages' => 3, 'files' => 0], $entry->changes);
        $dump = (string) json_encode($entry->toArray());
        foreach (['iban', 'Anna', '4915123456789'] as $personal) {
            $this->assertStringNotContainsString($personal, $dump);
        }
    }

    public function test_deleting_twice_or_deleting_something_that_never_existed_is_a_success_that_changes_nothing(): void
    {
        $chat = $this->chat();
        $api = fn (string $ulid) => $this->actingAs($this->admin, 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$ulid);

        $api($chat->ulid)->assertNoContent();
        $api($chat->ulid)->assertNoContent();
        $api('01j00000000000000000000000')->assertNoContent();

        $this->assertSame(1, AuditLog::query()->where('action', 'whatsapp.chat.deleted')->count(), 'only the real deletion is on record');
    }

    public function test_agents_and_everybody_else_cannot_erase_a_chat(): void
    {
        $chat = $this->chat();
        WaMessage::factory()->for($chat, 'chat')->inbound()->create();
        $people = $this->whatsAppPeople();

        $this->actingAs($people['agent'], 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertForbidden();
        $this->actingAs($people['noRole'], 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertForbidden();
        auth()->forgetGuards();
        $this->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertUnauthorized();

        $this->assertTrue(WaChat::query()->whereKey($chat->id)->exists());
        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(0, AuditLog::query()->where('action', 'whatsapp.chat.deleted')->count());
    }

    public function test_a_reply_still_queued_for_an_erased_chat_goes_nowhere(): void
    {
        Queue::fake();
        Event::fake();
        $chat = $this->chat();
        $chat->forceFill(['inbound_initiated' => true])->save();
        $this->session->forceFill(['status' => 'ready'])->save();
        $message = WaMessage::factory()->for($chat, 'chat')->outbound($this->admin)->pending()->create();

        $this->actingAs($this->admin, 'sanctum')->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertNoContent();
        (new SendWhatsAppMessage($message->id))->handle($this->openWa(), app(SendPacer::class), app(SendCounter::class));

        $this->openWa()->assertNotCalled('sendText');
    }
}
