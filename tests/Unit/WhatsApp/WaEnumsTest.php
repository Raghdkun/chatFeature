<?php

namespace Tests\Unit\WhatsApp;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\WhatsApp\Enums\WaRealtimeEvent;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The small WhatsApp enums: their stored values are part of the schema and of the TypeScript contract. */
class WaEnumsTest extends TestCase
{
    public function test_stored_values_are_the_documented_ones(): void
    {
        $this->assertSame(['open', 'archived'], array_column(WaChatStatus::cases(), 'value'));
        $this->assertSame(['in', 'out'], array_column(WaDirection::cases(), 'value'));
        $this->assertSame(['processed', 'duplicate', 'rejected', 'ignored', 'failed'], array_column(WebhookOutcome::cases(), 'value'));
        $this->assertSame(
            ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'other'],
            array_column(WaMessageType::cases(), 'value'),
        );
        $this->assertSame(
            ['wa.message.created', 'wa.message.updated', 'wa.chat.updated', 'wa.session.status'],
            array_column(WaRealtimeEvent::cases(), 'value'),
        );
    }

    public function test_only_in_is_inbound(): void
    {
        $this->assertTrue(WaDirection::In->isInbound());
        $this->assertFalse(WaDirection::Out->isInbound());
    }

    /**
     * @return iterable<string, array{?string, WaMessageType}>
     */
    public static function openWaTypes(): iterable
    {
        foreach (['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact'] as $type) {
            yield $type => [$type, WaMessageType::from($type)];
        }

        yield 'raw engine chat is text' => ['chat', WaMessageType::Text];
        yield 'raw engine ptt is a voice note' => ['ptt', WaMessageType::Voice];
        yield 'vcard is a contact' => ['vcard', WaMessageType::Contact];
        yield 'multi vcard is a contact' => ['multi_vcard', WaMessageType::Contact];
        yield 'gif is a video' => ['gif', WaMessageType::Video];
        yield 'upper case' => ['IMAGE', WaMessageType::Image];
        yield 'poll is other' => ['poll', WaMessageType::Other];
        yield 'call is other' => ['call', WaMessageType::Other];
        yield 'revoked is other' => ['revoked', WaMessageType::Other];
        yield 'masked is other' => ['masked', WaMessageType::Other];
        yield 'unknown is other' => ['hologram', WaMessageType::Other];
        yield 'empty is other' => ['', WaMessageType::Other];
        yield 'null is other' => [null, WaMessageType::Other];
    }

    #[DataProvider('openWaTypes')]
    public function test_openwa_message_types_map_tolerantly(?string $wire, WaMessageType $expected): void
    {
        $this->assertSame($expected, WaMessageType::fromOpenWa($wire));
    }

    public function test_media_types_and_the_one_that_is_stored(): void
    {
        $media = array_filter(WaMessageType::cases(), static fn (WaMessageType $type): bool => $type->isMedia());

        $this->assertSame(['image', 'video', 'audio', 'voice', 'document', 'sticker'], array_values(array_map(static fn (WaMessageType $t): string => $t->value, $media)));

        foreach (WaMessageType::cases() as $type) {
            $this->assertSame($type === WaMessageType::Image, $type->isStoredAsFile(), $type->value);
        }
    }
}
