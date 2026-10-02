<?php

namespace Tests\Unit\Notifications;

use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Support\DeviceLabel;
use App\Domain\Notifications\Support\PushMessage;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class PushMessageTest extends TestCase
{
    public function test_an_offer_payload_is_small_and_carries_only_what_the_worker_needs(): void
    {
        $message = new PushMessage(PushType::Offer, 'offer-01JABC', 'New chat request', 'Billing - Hello there', '/inbox/01JABC', 60, 'high', false, true);

        $this->assertSame([
            'v' => 1,
            'title' => 'New chat request',
            'body' => 'Billing - Hello there',
            'renotify' => false,
            'requireInteraction' => true,
            'data' => ['url' => '/inbox/01JABC', 'tag' => 'offer-01JABC', 'type' => 'offer'],
        ], $message->payload());
        $this->assertLessThan(1000, strlen((string) json_encode($message->payload())));
    }

    public function test_a_dismiss_is_silent_and_has_no_text(): void
    {
        $message = PushMessage::dismiss('offer-01JABC');

        $this->assertTrue($message->isSilent());
        $this->assertSame(['v' => 1, 'data' => ['url' => '/inbox', 'tag' => 'offer-01JABC', 'type' => 'dismiss']], $message->payload());
    }

    public function test_the_topic_is_url_safe_short_and_stable_per_tag(): void
    {
        $offer = new PushMessage(PushType::Offer, 'offer-01JABC', 't', 'b', '/inbox', 60);
        $dismiss = PushMessage::dismiss('offer-01JABC');
        $other = PushMessage::dismiss('offer-01JXYZ');

        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_-]{1,32}$/', $offer->topic());
        // The dismiss replaces a still-undelivered offer at the push service: same topic.
        $this->assertSame($offer->topic(), $dismiss->topic());
        $this->assertNotSame($offer->topic(), $other->topic());
    }

    public function test_it_survives_the_queue_round_trip(): void
    {
        $message = new PushMessage(PushType::Message, 'chat-01JABC', 'New message from Sam', 'Hi', '/inbox/01JABC', 900, 'normal', true, false);

        $this->assertEquals($message, PushMessage::fromArray(json_decode((string) json_encode($message->toArray()), true)));
    }

    public function test_an_unknown_urgency_becomes_normal(): void
    {
        $message = PushMessage::fromArray(['type' => 'offer', 'tag' => 't', 'url' => '/inbox', 'ttl' => 5, 'urgency' => 'urgent!!']);

        $this->assertSame('normal', $message->urgency);
    }

    /**
     * @return array<string, array{0: string|null, 1: string}>
     */
    public static function agents(): array
    {
        return [
            'chrome mac' => ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome on macOS'],
            'edge windows' => ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge on Windows'],
            'firefox linux' => ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
            'safari iphone' => ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
            'chrome android' => ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
            'unknown' => ['curl/8', 'Browser'],
            'missing' => [null, 'Browser'],
        ];
    }

    #[DataProvider('agents')]
    public function test_device_labels(?string $userAgent, string $expected): void
    {
        $this->assertSame($expected, DeviceLabel::fromUserAgent($userAgent));
    }
}
