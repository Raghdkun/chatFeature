<?php

namespace Tests\Support;

/**
 * Image bytes for the WhatsApp media tests (GD, no files): a plain JPEG, one carrying an EXIF block with a recognisable marker, a noisy
 * one that does not compress, and an animated GIF.
 */
final class Images
{
    public static function jpeg(int $width = 32, int $height = 24): string
    {
        $image = imagecreatetruecolor($width, $height);
        imagefilledrectangle($image, 0, 0, $width - 1, $height - 1, (int) imagecolorallocate($image, 30, 120, 200));
        ob_start();
        imagejpeg($image, null, 90);

        return (string) ob_get_clean();
    }

    /** A real JPEG with an EXIF (APP1) block that says `Exif` and `SECRET-GPS-MARKER`. */
    public static function jpegWithExif(int $width = 32, int $height = 24, string $marker = 'SECRET-GPS-MARKER'): string
    {
        $jpeg = self::jpeg($width, $height);
        $exif = "Exif\0\0".'MM'."\x00\x2A\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00".$marker;

        return substr($jpeg, 0, 2)."\xFF\xE1".pack('n', strlen($exif) + 2).$exif.substr($jpeg, 2);
    }

    /** Random pixels: a JPEG of this size is far bigger than a flat one. */
    public static function noisyJpeg(int $width, int $height): string
    {
        $image = imagecreatetruecolor($width, $height);

        for ($x = 0; $x < $width; $x++) {
            for ($y = 0; $y < $height; $y++) {
                imagesetpixel($image, $x, $y, (int) imagecolorallocate($image, random_int(0, 255), random_int(0, 255), random_int(0, 255)));
            }
        }

        ob_start();
        imagejpeg($image, null, 100);

        return (string) ob_get_clean();
    }

    public static function animatedGif(): string
    {
        return Gifs::animated(16, 3);
    }
}
