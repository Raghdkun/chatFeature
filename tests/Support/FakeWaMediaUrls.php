<?php

namespace Tests\Support;

use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Models\WaMessage;

/**
 * Media URLs without the signed route: deterministic strings that name the message (and carry a fake signature, so a test can tell them
 * from storage paths). Bound by `Tests\TestCase` (`$this->app->instance(WaMediaUrls::class, new FakeWaMediaUrls)`).
 */
final class FakeWaMediaUrls implements WaMediaUrls
{
    public function url(WaMessage $message): string
    {
        return 'https://files.test/whatsapp/'.$message->ulid.'?signature=fake';
    }
}
