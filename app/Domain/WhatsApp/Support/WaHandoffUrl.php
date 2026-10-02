<?php

namespace App\Domain\WhatsApp\Support;

/**
 * The `https://wa.me/<digits>?text=<text>` link of a hand-off (decision P6-D3): the visitor's WhatsApp opens a chat with the connected
 * number and the support code already typed in. The text is the `whatsapp.handoff_text` setting with `:code` replaced.
 */
final class WaHandoffUrl
{
    public const PLACEHOLDER = ':code';

    public const DEFAULT_TEXT = 'Hi! My support code is :code';

    /** Null when the number is unusable (a session that has not connected yet has none). */
    public static function build(?string $phone, string $template, string $code): ?string
    {
        $digits = PhoneNumber::digits($phone);

        if ($digits === null) {
            return null;
        }

        $text = str_replace(self::PLACEHOLDER, $code, $template);

        return 'https://wa.me/'.$digits.'?text='.rawurlencode($text);
    }
}
