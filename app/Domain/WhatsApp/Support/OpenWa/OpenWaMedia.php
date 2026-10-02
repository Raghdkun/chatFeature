<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

/**
 * The bytes of a message's media as OpenWA serves them (`GET .../media`). `mime` is the `Content-Type` OpenWA reports (an inert type
 * from its conservative list, else `application/octet-stream`): the caller still verifies what the bytes really are before storing them.
 */
final readonly class OpenWaMedia
{
    public function __construct(
        public string $contents,
        public string $mime,
        public ?string $filename = null,
    ) {}

    public function size(): int
    {
        return strlen($this->contents);
    }
}
