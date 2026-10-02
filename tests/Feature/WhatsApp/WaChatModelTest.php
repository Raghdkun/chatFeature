<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class WaChatModelTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_new_chat_is_open_unread_free_and_started_by_the_customer(): void
    {
        $chat = WaChat::factory()->create()->fresh();

        $this->assertNotNull($chat);
        $this->assertSame(WaChatStatus::Open, $chat->status);
        $this->assertFalse($chat->is_group);
        $this->assertTrue($chat->inbound_initiated);
        $this->assertSame(0, $chat->unread_by_admin);
        $this->assertFalse($chat->isLinked());
        $this->assertFalse($chat->isArchived());
        $this->assertStringEndsWith('@c.us', $chat->chat_id);
        $this->assertSame('+'.strstr($chat->chat_id, '@', true), $chat->phone_e164);
    }

    public function test_the_factory_states(): void
    {
        $group = WaChat::factory()->group()->create();
        $this->assertTrue($group->is_group);
        $this->assertStringEndsWith('@g.us', $group->chat_id);
        $this->assertNull($group->phone_e164);

        $lid = WaChat::factory()->privacyId()->create();
        $this->assertStringEndsWith('@lid', $lid->chat_id);
        $this->assertNull($lid->phone_e164);

        $this->assertTrue(WaChat::factory()->archived()->create()->isArchived());

        $unread = WaChat::factory()->unread(4)->create();
        $this->assertSame(4, $unread->unread_by_admin);
        $this->assertNotNull($unread->last_message_at);

        $this->assertFalse(WaChat::factory()->outboundOnly()->create()->inbound_initiated);
    }

    public function test_a_linked_chat_names_the_widget_visitor_topic_and_ticket_that_matched_it(): void
    {
        $category = Category::factory()->create();
        $chat = WaChat::factory()->linked(category: $category)->create()->fresh();

        $this->assertNotNull($chat);
        $this->assertTrue($chat->isLinked());
        $this->assertTrue($chat->category?->is($category));
        $this->assertTrue($chat->visitor?->widget?->is($chat->widget));
        $this->assertNotNull($chat->handoffTicket);
        $this->assertTrue($chat->handoffTicket->isConsumed());
        $this->assertSame($chat->id, $chat->handoffTicket->wa_chat_id);
        $this->assertSame($chat->session_id, $chat->handoffTicket->session_id);
    }

    public function test_the_scopes(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $other = WhatsAppSession::factory()->ready()->create();
        $open = WaChat::factory()->create(['session_id' => $session->id]);
        $archived = WaChat::factory()->archived()->create(['session_id' => $session->id]);
        $elsewhere = WaChat::factory()->create(['session_id' => $other->id]);
        $linked = WaChat::factory()->linked()->create(['session_id' => $session->id]);

        $this->assertEqualsCanonicalizing([$open->id, $elsewhere->id, $linked->id], WaChat::query()->open()->pluck('id')->all());
        $this->assertEqualsCanonicalizing([$open->id, $archived->id, $linked->id], WaChat::query()->forSession($session)->pluck('id')->all());
        $this->assertEqualsCanonicalizing([$elsewhere->id], WaChat::query()->forSession($other->id)->pluck('id')->all());
        $this->assertSame([$linked->id], WaChat::query()->linked()->pluck('id')->all());
        $this->assertSame([$open->id, $linked->id], WaChat::query()->forSession($session)->open()->orderBy('id')->pluck('id')->all(), 'scopes chain');
    }

    public function test_the_relations_reach_everything_a_chat_belongs_to(): void
    {
        $widget = Widget::factory()->create();
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id]);
        $category = Category::factory()->create();
        $chat = WaChat::factory()->linked($widget, $visitor, $category)->create();

        $this->assertTrue($chat->session->isUsable());
        $this->assertTrue($widget->waChats()->first()?->is($chat));
        $this->assertTrue($visitor->waChats()->first()?->is($chat));
        $this->assertTrue($category->waChats()->first()?->is($chat));
        $this->assertSame(1, $widget->waHandoffTickets()->count());
        $this->assertSame(1, $visitor->waHandoffTickets()->count());
    }

    public function test_the_transcript_is_oldest_first_by_id(): void
    {
        $chat = WaChat::factory()->create();
        $first = WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'wa_timestamp' => now()->subMinutes(5)]);
        $second = WaMessage::factory()->outbound()->create(['wa_chat_id' => $chat->id]);
        $third = WaMessage::factory()->create(['wa_chat_id' => $chat->id]);

        $this->assertSame([$first->id, $second->id, $third->id], $chat->messages()->pluck('id')->all());
    }

    public function test_messages_keep_the_chat_list_columns_in_step(): void
    {
        $chat = WaChat::factory()->create();

        WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'body' => 'Where is my order?', 'wa_timestamp' => now()->subMinute()]);
        $reply = WaMessage::factory()->outbound()->create(['wa_chat_id' => $chat->id, 'body' => 'It ships today.']);

        $chat->refresh();
        $this->assertSame('It ships today.', $chat->last_message_preview);
        $this->assertTrue($chat->last_message_at?->equalTo($reply->wa_timestamp));
        $this->assertNotNull($chat->last_inbound_at, 'the customer wrote first');
        $this->assertTrue($chat->last_inbound_at->lessThan($chat->last_message_at));

        WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'body' => 'Older', 'wa_timestamp' => now()->subHour()]);
        $this->assertSame('It ships today.', $chat->fresh()?->last_message_preview, 'a message from the past does not become the latest');
    }

    public function test_a_message_is_inbound_text_by_default_and_outbound_when_an_administrator_wrote_it(): void
    {
        $inbound = WaMessage::factory()->create()->fresh();
        $this->assertNotNull($inbound);
        $this->assertSame(WaDirection::In, $inbound->direction);
        $this->assertSame(WaMessageType::Text, $inbound->type);
        $this->assertSame(WaMessageStatus::Received, $inbound->status);
        $this->assertTrue($inbound->isInbound());
        $this->assertFalse($inbound->isOutbound());
        $this->assertNull($inbound->sent_by_user_id);

        $admin = User::factory()->admin()->create();
        $outbound = WaMessage::factory()->outbound($admin)->create();
        $this->assertTrue($outbound->isOutbound());
        $this->assertSame(WaMessageStatus::Sent, $outbound->status);
        $this->assertTrue($outbound->sentBy?->is($admin));
        $this->assertSame(1, $admin->sentWhatsAppMessages()->count());
        $this->assertTrue($outbound->chat->is(WaChat::query()->findOrFail($outbound->wa_chat_id)));
    }

    public function test_message_factory_states(): void
    {
        $pending = WaMessage::factory()->outbound()->pending()->create();
        $this->assertSame(WaMessageStatus::Pending, $pending->status);
        $this->assertNull($pending->wa_message_id);

        $this->assertSame(WaMessageStatus::Delivered, WaMessage::factory()->outbound()->delivered()->create()->status);
        $this->assertSame(WaMessageStatus::Read, WaMessage::factory()->outbound()->read()->create()->status);

        $failed = WaMessage::factory()->outbound()->failed('number not on WhatsApp')->create();
        $this->assertSame(WaMessageStatus::Failed, $failed->status);
        $this->assertSame('number not on WhatsApp', $failed->error);

        $image = WaMessage::factory()->image('look')->create();
        $this->assertSame(WaMessageType::Image, $image->type);
        $this->assertTrue($image->hasStoredMedia());
        $this->assertSame('look', $image->body);

        $document = WaMessage::factory()->document('invoice.pdf')->create();
        $this->assertSame(WaMessageType::Document, $document->type);
        $this->assertFalse($document->hasStoredMedia(), 'recorded as a typed row only');
        $this->assertSame('invoice.pdf', $document->media_filename);

        $this->assertSame(WaMessageType::Voice, WaMessage::factory()->voice()->create()->type);
    }

    public function test_the_raw_payload_and_the_storage_path_are_stored_but_never_serialised(): void
    {
        $message = WaMessage::factory()->image()->create(['raw' => ['id' => 'x', 'data' => ['contact' => ['pushName' => 'Sam']]]]);

        $this->assertSame('Sam', $message->fresh()?->raw['data']['contact']['pushName']);
        $this->assertNotNull(DB::table('wa_messages')->where('id', $message->id)->value('media_path'));

        $array = $message->fresh()?->toArray() ?? [];
        $this->assertArrayNotHasKey('raw', $array);
        $this->assertArrayNotHasKey('media_path', $array);
    }
}
