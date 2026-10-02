<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Models\WaWebhookDelivery;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WaWebhookDeliveryModelTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_processed_delivery_has_an_outcome_and_a_time(): void
    {
        $delivery = WaWebhookDelivery::factory()->create()->fresh();

        $this->assertNotNull($delivery);
        $this->assertSame(WebhookOutcome::Processed, $delivery->outcome);
        $this->assertTrue($delivery->isProcessed());
        $this->assertSame('message.received', $delivery->event);
        $this->assertStringStartsWith('dlv_', (string) $delivery->delivery_id);
        $this->assertTrue($delivery->session->isUsable());
    }

    public function test_an_accepted_delivery_waits_without_an_outcome(): void
    {
        $delivery = WaWebhookDelivery::factory()->pending()->create()->fresh();

        $this->assertNotNull($delivery);
        $this->assertNull($delivery->outcome);
        $this->assertFalse($delivery->isProcessed());
    }

    public function test_the_other_outcomes(): void
    {
        $this->assertSame(WebhookOutcome::Duplicate, WaWebhookDelivery::factory()->duplicate()->create()->outcome);
        $this->assertSame(WebhookOutcome::Rejected, WaWebhookDelivery::factory()->rejected()->create()->outcome);

        $ignored = WaWebhookDelivery::factory()->ignored()->create();
        $this->assertSame(WebhookOutcome::Ignored, $ignored->outcome);
        $this->assertSame('presence.update', $ignored->event);

        $failed = WaWebhookDelivery::factory()->failed('boom')->create();
        $this->assertSame(WebhookOutcome::Failed, $failed->outcome);
        $this->assertSame('boom', $failed->error);
    }

    public function test_a_key_that_fits_the_column_is_used_as_it_is_and_a_longer_one_is_hashed(): void
    {
        $key = 'msg_8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a_true_628123456789@c.us_3EB0ABCD_f1e2d3c4-b5a6-7890-1234-567890abcdef';
        $long = str_repeat('k', 400);

        $this->assertSame($key, WaWebhookDelivery::keyFor($key));
        $this->assertSame(str_repeat('k', 255), WaWebhookDelivery::keyFor(str_repeat('k', 255)));
        $this->assertSame('sha256:'.hash('sha256', $long), WaWebhookDelivery::keyFor($long));
        $this->assertSame(WaWebhookDelivery::keyFor($long), WaWebhookDelivery::keyFor($long), 'deterministic: the same long key is the same row');
        $this->assertLessThanOrEqual(255, strlen(WaWebhookDelivery::keyFor($long)));

        $delivery = WaWebhookDelivery::factory()->create(['idempotency_key' => WaWebhookDelivery::keyFor($long)]);
        $this->assertSame(WaWebhookDelivery::keyFor($long), $delivery->fresh()?->idempotency_key);
    }
}
