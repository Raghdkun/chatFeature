<?php

namespace Tests\Unit\WhatsApp;

use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Domain\WhatsApp\Support\WaHandoffUrl;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class PhoneNumberTest extends TestCase
{
    /**
     * @return iterable<string, array{?string, ?string}>
     */
    public static function numbers(): iterable
    {
        yield 'bare digits as OpenWA reports a session' => ['4915123456789', '+4915123456789'];
        yield 'already e164' => ['+4915123456789', '+4915123456789'];
        yield 'spaces and dashes' => ['+49 151-234 56789', '+4915123456789'];
        yield 'too short' => ['12345', null];
        yield 'too long' => ['1234567890123456', null];
        yield 'letters only' => ['abc', null];
        yield 'empty' => ['', null];
        yield 'null' => [null, null];
    }

    #[DataProvider('numbers')]
    public function test_e164(?string $input, ?string $expected): void
    {
        $this->assertSame($expected, PhoneNumber::e164($input));
    }

    /**
     * @return iterable<string, array{?string, ?string}>
     */
    public static function chatIds(): iterable
    {
        yield 'a person' => ['4915123456789@c.us', '+4915123456789'];
        yield 'the baileys spelling' => ['4915123456789@s.whatsapp.net', '+4915123456789'];
        yield 'with a device suffix' => ['4915123456789:12@c.us', '+4915123456789'];
        yield 'a privacy id has no number' => ['148230817489052@lid', null];
        yield 'a group has no number' => ['120363025246125486@g.us', null];
        yield 'garbage' => ['hello', null];
        yield 'null' => [null, null];
    }

    #[DataProvider('chatIds')]
    public function test_the_number_behind_a_chat_id(?string $chatId, ?string $expected): void
    {
        $this->assertSame($expected, PhoneNumber::fromChatId($chatId));
    }

    public function test_groups_are_recognised_by_their_id(): void
    {
        $this->assertTrue(PhoneNumber::isGroupChatId('120363025246125486@g.us'));
        $this->assertFalse(PhoneNumber::isGroupChatId('4915123456789@c.us'));
        $this->assertFalse(PhoneNumber::isGroupChatId(null));
    }

    public function test_a_masked_number_keeps_the_country_part_and_the_last_four_digits(): void
    {
        $this->assertSame('+49•••••••6789', PhoneNumber::mask('+4915123456789'));
        $this->assertSame('+62•••••••7890', PhoneNumber::mask('6281234567890'));
        $this->assertSame('+12•4567', PhoneNumber::mask('+1234567'), 'at least one bullet, however short');
        $this->assertNull(PhoneNumber::mask(null));
        $this->assertNull(PhoneNumber::mask('12'));
    }

    public function test_the_handoff_link_opens_whatsapp_with_the_code_typed_in(): void
    {
        $url = WaHandoffUrl::build('+4915123456789', 'Hi! My support code is :code', 'K7M2QX3P');

        $this->assertSame('https://wa.me/4915123456789?text=Hi%21%20My%20support%20code%20is%20K7M2QX3P', $url);
    }

    public function test_the_handoff_text_is_url_encoded_and_the_link_needs_a_number(): void
    {
        $this->assertSame('https://wa.me/4915123456789?text=%C3%84rger%20%26%20Co%3A%20ABCDEFGH', WaHandoffUrl::build('4915123456789', 'Ärger & Co: :code', 'ABCDEFGH'));
        $this->assertNull(WaHandoffUrl::build(null, WaHandoffUrl::DEFAULT_TEXT, 'ABCDEFGH'));
        $this->assertNull(WaHandoffUrl::build('', WaHandoffUrl::DEFAULT_TEXT, 'ABCDEFGH'));
    }
}
