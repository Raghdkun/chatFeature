<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * The text a visitor's WhatsApp opens with (`whatsapp.handoff_text`): one line, at most 200 characters, and it must contain the `:code`
 * placeholder, otherwise the visitor would send a message the application cannot link to their chat.
 */
final class HandoffText implements ValidationRule
{
    public const MAX_LENGTH = 200;

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || trim($value) === '' || mb_strlen($value) > self::MAX_LENGTH || preg_match('/[\x00-\x1F\x7F]/', $value) === 1) {
            $fail(__('Enter one line of text, at most :max characters.', ['max' => self::MAX_LENGTH]));

            return;
        }

        if (! str_contains($value, ':code')) {
            $fail(__('The text must contain :code, where the visitor\'s support code goes.'));
        }
    }
}
