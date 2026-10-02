<?php

namespace App\Domain\WhatsApp\Contracts;

use App\Models\WaMessage;

/**
 * Turns the stored file of a WhatsApp message into the short-lived URL an administrator's browser (or the mobile app) loads it from
 * (`WaMediaData.url`). The default implementation signs the named route `whatsapp.media.show` that the WhatsApp REST track (6A)
 * registers behind `wa.admin`; tests bind `Tests\Support\FakeWaMediaUrls` so Data classes can be built without that route.
 */
interface WaMediaUrls
{
    /** Signed URL of the message's file; only called for a message with stored media (`WaMessage::hasStoredMedia()`). */
    public function url(WaMessage $message): string;
}
