<?php

namespace Tests\Support;

/**
 * Builds GIFs for the upload tests: a one-frame GIF repeated into an animation (a small file for any canvas size, which is what
 * makes a "pixel bomb": the decoder allocates a full canvas per frame).
 */
final class Gifs
{
    /**
     * @return string the bytes of a GIF with `$frames` identical frames of `$side` x `$side` pixels
     */
    public static function animated(int $side, int $frames): string
    {
        $image = imagecreate($side, $side);
        imagecolorallocate($image, 10, 10, 10);
        imagecolorallocate($image, 200, 200, 200);
        ob_start();
        imagegif($image);
        $one = (string) ob_get_clean();

        $flags = ord($one[10]);
        $position = 13 + (($flags & 0x80) !== 0 ? 3 * (1 << (($flags & 0x07) + 1)) : 0);
        $head = substr($one, 0, $position);
        $rest = substr($one, $position, -1);
        $frame = substr($rest, (int) strpos($rest, "\x2C"));

        $gif = $head."\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00";

        for ($i = 0; $i < $frames; $i++) {
            $gif .= "\x21\xF9\x04\x00\x0A\x00\x00\x00".$frame;
        }

        return $gif."\x3B";
    }

    /** A plain one-frame GIF. */
    public static function still(int $side = 16): string
    {
        $image = imagecreatetruecolor($side, $side);
        ob_start();
        imagegif($image);

        return (string) ob_get_clean();
    }
}
