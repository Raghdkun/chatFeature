<?php

namespace App\Domain\Chat\Services;

/** An uploaded image after validation and re-encoding: what is stored, never the original bytes. */
final readonly class SanitizedImage
{
    public function __construct(
        public string $mime,
        public string $extension,
        public string $bytes,
        public string $thumbBytes,
        public int $width,
        public int $height,
    ) {}
}
