<?php

namespace Tests\Feature\WhatsApp;

use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `WaChat::search()`: number, name, last message, the linked visitor and message text. Runs on SQLite (LIKE) in the suite and on MySQL
 * (FULLTEXT for the message text) when the suite is pointed at a MySQL database.
 */
class WaChatSearchTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return list<int>
     */
    private function found(string $text): array
    {
        $ids = WaChat::query()->search($text)->pluck('id')->all();
        sort($ids);

        return $ids;
    }

    public function test_it_finds_a_chat_by_number_with_or_without_formatting(): void
    {
        $chat = WaChat::factory()->create(['chat_id' => '4915112345678@c.us', 'phone_e164' => '+4915112345678']);
        WaChat::factory()->create(['chat_id' => '4917600000000@c.us', 'phone_e164' => '+4917600000000']);

        $this->assertSame([$chat->id], $this->found('+4915112345678'));
        $this->assertSame([$chat->id], $this->found('15112345'));
        $this->assertSame([$chat->id], $this->found('+49 151 12345'), 'spaces in what an admin types do not matter');
        $this->assertSame([$chat->id], $this->found('151-123'));
    }

    public function test_it_finds_a_chat_by_push_name_and_last_message(): void
    {
        $sam = WaChat::factory()->create(['push_name' => 'Samantha Jones', 'last_message_preview' => 'Is my parcel on its way?']);
        WaChat::factory()->create(['push_name' => 'Robert']);

        $this->assertSame([$sam->id], $this->found('samantha'));
        $this->assertSame([$sam->id], $this->found('parcel'));
    }

    public function test_it_finds_a_chat_by_the_visitor_it_is_linked_to(): void
    {
        $linked = WaChat::factory()->linked()->create();
        $visitor = Visitor::query()->findOrFail($linked->visitor_id);
        $visitor->forceFill(['name' => 'Priya Natarajan', 'email' => 'priya@example.org', 'phone' => '555-0100'])->save();
        WaChat::factory()->create();

        $this->assertSame([$linked->id], $this->found('natarajan'));
        $this->assertSame([$linked->id], $this->found('priya@example'));
        $this->assertSame([$linked->id], $this->found('555-0100'));
    }

    public function test_it_finds_a_chat_by_the_text_of_any_of_its_messages(): void
    {
        $chat = WaChat::factory()->create();
        WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'body' => 'Hello there']);
        WaMessage::factory()->outbound()->create(['wa_chat_id' => $chat->id, 'body' => 'Your invoice number is 4711']);
        $other = WaChat::factory()->create();
        WaMessage::factory()->create(['wa_chat_id' => $other->id, 'body' => 'Completely unrelated']);

        $this->assertSame([$chat->id], $this->found('invoice'));
        $this->assertSame([$chat->id], $this->found('invoice number'));
        $this->assertSame([$chat->id], $this->found('4711'), 'a word shorter than the FULLTEXT minimum still matches');
        $this->assertSame([], $this->found('invoice zebra'));
    }

    public function test_like_wildcards_in_the_text_are_literal(): void
    {
        $chat = WaChat::factory()->create(['last_message_preview' => '100% sure']);
        WaChat::factory()->create(['last_message_preview' => '100 sure']);

        $this->assertSame([$chat->id], $this->found('100%'));
        $this->assertSame([], $this->found('_'));
        $this->assertSame([], $this->found('!'));
    }

    public function test_an_empty_search_changes_nothing_and_the_scope_chains(): void
    {
        WaChat::factory()->count(2)->create();
        $archived = WaChat::factory()->archived()->create(['push_name' => 'Zed']);

        $this->assertCount(3, WaChat::query()->search('  ')->get());
        $this->assertSame([$archived->id], WaChat::query()->search('zed')->pluck('id')->all());
        $this->assertSame([], WaChat::query()->open()->search('zed')->pluck('id')->all(), 'search narrows the other scopes, it does not widen them');
    }
}
