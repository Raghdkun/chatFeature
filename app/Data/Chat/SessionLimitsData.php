<?php

namespace App\Data\Chat;

use App\Domain\Chat\Actions\SendMessage;
use App\Domain\Chat\Services\MessageText;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What the visitor panel may check before it sends: the effective settings (`chat.max_message_length`, kept within the hard limit,
 * `chat.attachment_max_bytes`, `chat.attachment_max_dimension`) and the number of images one message may carry. The server
 * enforces all of them; the panel only avoids a round trip that is certain to fail.
 */
#[TypeScript]
class SessionLimitsData extends Data
{
    public function __construct(
        public int $maxMessageLength,
        public int $attachmentMaxBytes,
        public int $attachmentMaxDimension,
        public int $attachmentMaxPerMessage,
    ) {}

    public static function current(): self
    {
        return new self(
            maxMessageLength: MessageText::maxLength(),
            attachmentMaxBytes: max(1, settings()->int('chat.attachment_max_bytes', 5 * 1024 * 1024)),
            attachmentMaxDimension: max(1, settings()->int('chat.attachment_max_dimension', 4096)),
            attachmentMaxPerMessage: SendMessage::MAX_ATTACHMENTS,
        );
    }
}
