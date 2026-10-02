<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Domain\WhatsApp\Services\ChatLinker;
use App\Models\Category;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\OpenWaWebhooks;
use Tests\TestCase;

/**
 * The hand-off code in a customer's first messages links the chat to the widget, visitor and topic the ticket was made for. Anything
 * that is not exactly a live ticket's code, said to the right number, links nothing.
 */
class ChatLinkerTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase;

    private WhatsAppSession $session;

    private WaHandoffTicket $ticket;

    private Widget $widget;

    private Visitor $visitor;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();

        $this->session = $this->webhookSession();
        $this->widget = Widget::factory()->create();
        $this->visitor = Visitor::factory()->create(['widget_id' => $this->widget->id, 'name' => 'Vera Visitor']);
        $this->category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $this->ticket = WaHandoffTicket::factory()->create([
            'widget_id' => $this->widget->id, 'visitor_id' => $this->visitor->id, 'category_id' => $this->category->id,
            'session_id' => $this->session->id, 'code' => 'K7M2QX4P', 'expires_at' => now()->addHour(),
        ]);
    }

    private function say(string $text, string $from = self::CUSTOMER): void
    {
        $this->deliver($this->session, $this->messageReceived(['body' => $text, 'from' => $from, 'chatId' => $from]))->assertOk();
    }

    public function test_the_code_in_the_first_message_links_the_chat_and_consumes_the_ticket(): void
    {
        Event::fake([WaChatLinked::class]);

        $this->say('Hi! My support code is K7M2QX4P');

        $chat = WaChat::query()->sole();
        $this->assertSame($this->widget->id, $chat->widget_id);
        $this->assertSame($this->visitor->id, $chat->visitor_id);
        $this->assertSame($this->category->id, $chat->category_id);
        $this->assertSame($this->ticket->id, $chat->handoff_ticket_id);
        $this->assertTrue($chat->isLinked());

        $ticket = $this->ticket->refresh();
        $this->assertNotNull($ticket->consumed_at);
        $this->assertSame($chat->id, $ticket->wa_chat_id);
        Event::assertDispatched(WaChatLinked::class, fn (WaChatLinked $event): bool => $event->chat->is($chat) && $event->ticket->is($ticket));
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function spellings(): iterable
    {
        yield 'lower case' => ['hi my support code is k7m2qx4p'];
        yield 'mixed case' => ['K7m2Qx4p please'];
        yield 'alone' => ['K7M2QX4P'];
        yield 'with punctuation' => ['code: K7M2QX4P.'];
        yield 'in parentheses' => ['(K7M2QX4P)'];
        yield 'on its own line' => ["Hello\nK7M2QX4P\nthanks"];
        yield 'next to a hyphen' => ['ref-K7M2QX4P-end'];
        yield 'surrounded by emoji' => ['👋K7M2QX4P👋'];
        yield 'with padding' => ["  K7M2QX4P \n"];
        yield 'twice' => ['K7M2QX4P K7M2QX4P'];
    }

    #[DataProvider('spellings')]
    public function test_the_code_is_found_however_the_customer_typed_it(string $text): void
    {
        $this->say($text);

        $this->assertSame($this->ticket->id, WaChat::query()->sole()->handoff_ticket_id);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function nonMatches(): iterable
    {
        yield 'inside a longer word' => ['XK7M2QX4P'];
        yield 'followed by letters' => ['K7M2QX4PZ'];
        yield 'followed by digits' => ['K7M2QX4P9'];
        yield 'after an underscore' => ['_K7M2QX4P'];
        yield 'one character short' => ['K7M2QX4'];
        yield 'a different code' => ['K7M2QX4Q'];
        yield 'a look-alike zero for O' => ['K7M2QX0P'];
        yield 'cyrillic K' => ["\u{041A}7M2QX4P"];
        yield 'greek rho for P' => ["K7M2QX4\u{03A1}"];
        yield 'full width letters' => ['Ｋ7M2QX4P'];
        yield 'a long s for S in another code' => ['no code here at all'];
        yield 'letters of the code spread out' => ['K 7 M 2 Q X 4 P'];
        yield 'inside a url' => ['https://x.test/a/K7M2QX4Pb'];
        yield 'a zero width joiner inside' => ["K7M2\u{200D}QX4P"];
    }

    #[DataProvider('nonMatches')]
    public function test_something_that_is_not_the_code_links_nothing_and_leaves_the_ticket_alone(string $text): void
    {
        $this->say($text);

        $chat = WaChat::query()->sole();
        $this->assertFalse($chat->isLinked());
        $this->assertNull($chat->handoff_ticket_id);
        $this->assertNull($this->ticket->refresh()->consumed_at);
        $this->assertSame(1, WaMessage::query()->count(), 'the chat is recorded all the same');
    }

    public function test_an_expired_ticket_never_links(): void
    {
        $this->ticket->update(['expires_at' => now()->subSecond()]);

        $this->say('K7M2QX4P');

        $this->assertFalse(WaChat::query()->sole()->isLinked());
        $this->assertNull($this->ticket->refresh()->consumed_at);
    }

    public function test_a_consumed_ticket_never_links_a_second_chat_a_code_pasted_by_somebody_else(): void
    {
        $this->say('K7M2QX4P');
        $this->assertSame($this->ticket->id, WaChat::query()->sole()->handoff_ticket_id);

        $stranger = '4917611122233@c.us';
        $this->say('I saw this code K7M2QX4P on a screenshot', $stranger);

        $other = WaChat::query()->where('chat_id', $stranger)->sole();
        $this->assertFalse($other->isLinked());
        $this->assertSame(WaChat::query()->where('chat_id', self::CUSTOMER)->value('id'), $this->ticket->refresh()->wa_chat_id, 'the ticket still names the first chat');
    }

    public function test_a_code_for_another_number_links_nothing(): void
    {
        $otherSession = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');

        $this->deliver($otherSession, $this->messageReceived(['body' => 'K7M2QX4P']))->assertOk();

        $this->assertFalse(WaChat::query()->sole()->isLinked());
        $this->assertNull($this->ticket->refresh()->consumed_at);
    }

    public function test_a_chat_that_is_already_linked_is_never_linked_again(): void
    {
        $this->say('K7M2QX4P');
        $second = WaHandoffTicket::factory()->create([
            'widget_id' => Widget::factory()->create()->id, 'session_id' => $this->session->id, 'code' => 'ABCD2345', 'expires_at' => now()->addHour(),
        ]);

        $this->say('and here is another code ABCD2345');

        $chat = WaChat::query()->sole();
        $this->assertSame($this->ticket->id, $chat->handoff_ticket_id);
        $this->assertNull($second->refresh()->consumed_at);
    }

    public function test_the_code_is_found_in_a_later_of_the_first_messages_but_not_after_the_search_window(): void
    {
        config(['whatsapp.linker.max_inbound_messages' => 2]);
        $this->say('hello');
        $this->say('anybody there?');
        $this->say('K7M2QX4P');

        $this->assertFalse(WaChat::query()->sole()->isLinked(), 'the third message is past the window');

        $fresh = '4917699999999@c.us';
        $this->say('hello', $fresh);
        $this->say('K7M2QX4P', $fresh);
        $this->assertSame($this->ticket->id, WaChat::query()->where('chat_id', $fresh)->value('handoff_ticket_id'), 'the second message is still inside it');
    }

    public function test_a_caption_of_an_image_counts(): void
    {
        $this->deliver($this->session, $this->messageReceived(['type' => 'image', 'body' => 'K7M2QX4P', 'media' => ['omitted' => true]]))->assertOk();

        $this->assertSame($this->ticket->id, WaChat::query()->sole()->handoff_ticket_id);
    }

    public function test_the_phones_own_message_never_links(): void
    {
        $this->deliver($this->session, $this->messageReceived(['body' => 'K7M2QX4P', 'fromMe' => true, 'from' => '6281234567890@c.us', 'to' => self::CUSTOMER, 'chatId' => self::CUSTOMER]))->assertOk();

        $this->assertFalse(WaChat::query()->sole()->isLinked());
        $this->assertNull($this->ticket->refresh()->consumed_at);
    }

    public function test_one_ticket_links_only_one_chat_even_when_two_customers_say_it_at_once(): void
    {
        $linker = app(ChatLinker::class);
        $first = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => '4917600000001@c.us']);
        $second = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => '4917600000002@c.us']);
        $one = WaMessage::factory()->for($first, 'chat')->inbound()->create(['body' => 'K7M2QX4P']);
        $two = WaMessage::factory()->for($second, 'chat')->inbound()->create(['body' => 'K7M2QX4P']);

        // Both read the live ticket before either claimed it (the race): the guarded UPDATE lets exactly one win.
        $this->assertTrue($linker->attempt($first, $one));
        $this->assertFalse($linker->attempt($second, $two));

        $this->assertSame($first->id, $this->ticket->refresh()->wa_chat_id);
        $this->assertFalse($second->refresh()->isLinked());
    }

    public function test_two_live_tickets_in_one_message_link_the_oldest(): void
    {
        $newer = WaHandoffTicket::factory()->create([
            'widget_id' => $this->widget->id, 'session_id' => $this->session->id, 'code' => 'ABCD2345', 'expires_at' => now()->addHour(),
        ]);

        $this->say('ABCD2345 and K7M2QX4P');

        $this->assertSame($this->ticket->id, WaChat::query()->sole()->handoff_ticket_id);
        $this->assertNull($newer->refresh()->consumed_at);
    }

    public function test_candidates_are_unique_ascii_upper_case_and_bounded(): void
    {
        $linker = app(ChatLinker::class);

        $this->assertSame(['K7M2QX4P'], $linker->candidates('k7m2qx4p K7M2QX4P'));
        $this->assertSame([], $linker->candidates(null));
        $this->assertSame([], $linker->candidates(''));
        $this->assertCount(5, $linker->candidates(implode(' ', ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD', 'EEEEEEEE', 'FFFFFFFF', 'GGGGGGGG'])));
        $this->assertSame([], $linker->candidates("K7M2QX4\u{017F}"), 'a long s does not upper-case into an S');
    }
}
