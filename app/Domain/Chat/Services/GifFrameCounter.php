<?php

namespace App\Domain\Chat\Services;

/**
 * Counts the frames of a GIF by walking its block structure (header, screen descriptor, colour tables, extensions and image
 * descriptors with their data sub-blocks) without decoding a single pixel. Cheap enough to run on any upload before the decoder
 * sees it: a "pixel bomb" GIF (a big canvas repeated in many frames) is recognised by its frame count, not by its file size.
 *
 * The walk stops as soon as `$stopAfter` frames were seen, so a hostile file cannot make it run long. Malformed or truncated
 * data simply ends the walk with the frames counted so far; the decoder refuses it later.
 */
final class GifFrameCounter
{
    private const EXTENSION = 0x21;

    private const IMAGE = 0x2C;

    private const TRAILER = 0x3B;

    /**
     * @return int the number of image frames found, at most `$stopAfter`
     */
    public function count(string $binary, int $stopAfter = 2): int
    {
        $length = strlen($binary);

        if ($length < 13 || ! in_array(substr($binary, 0, 6), ['GIF87a', 'GIF89a'], true)) {
            return 0;
        }

        $packed = ord($binary[10]);
        $position = 13 + (($packed & 0x80) !== 0 ? 3 * (1 << (($packed & 0x07) + 1)) : 0);
        $frames = 0;

        while ($position < $length && $frames < $stopAfter) {
            $block = ord($binary[$position]);

            if ($block === self::TRAILER) {
                break;
            }

            if ($block === self::EXTENSION) {
                // Introducer, label, then data sub-blocks.
                $position = $this->skipSubBlocks($binary, $position + 2, $length);

                continue;
            }

            if ($block !== self::IMAGE || $position + 10 > $length) {
                break;
            }

            $frames++;
            $local = ord($binary[$position + 9]);
            $position += 10 + (($local & 0x80) !== 0 ? 3 * (1 << (($local & 0x07) + 1)) : 0);
            // LZW minimum code size, then the pixel data sub-blocks.
            $position = $this->skipSubBlocks($binary, $position + 1, $length);
        }

        return $frames;
    }

    /** The position just after a run of sub-blocks (each a length byte and that many bytes) ended by a zero length. */
    private function skipSubBlocks(string $binary, int $position, int $length): int
    {
        while ($position < $length) {
            $size = ord($binary[$position]);
            $position += 1 + $size;

            if ($size === 0) {
                return $position;
            }
        }

        return $length;
    }
}
