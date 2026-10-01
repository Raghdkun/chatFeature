<?php

namespace App\Domain\Chat\Services;

use finfo;
use Illuminate\Validation\ValidationException;
use Intervention\Image\Drivers\Gd\Driver as GdDriver;
use Intervention\Image\Encoders\GifEncoder;
use Intervention\Image\Encoders\JpegEncoder;
use Intervention\Image\Encoders\PngEncoder;
use Intervention\Image\Encoders\WebpEncoder;
use Intervention\Image\ImageManager;
use Intervention\Image\Interfaces\EncoderInterface;
use Throwable;

/**
 * The upload pipeline of decision P4-D9: the file is judged by its CONTENT, never by what the client says it is.
 *
 * 1. size and `finfo` mime type must be jpeg / png / webp / gif (SVG, HTML, PDF, ... are refused);
 * 2. the header's dimensions must stay within the limit, and decoding must fit the memory still available (a decompression bomb
 *    is refused before it is decoded);
 * 3. bytes that look like script or markup anywhere in the file (a polyglot image) are refused;
 * 4. the image is decoded and encoded again: EXIF / XMP / comments / trailing data do not survive, orientation is applied first,
 *    animated GIFs become their first frame. A 320 px thumbnail is made from the same decode.
 *
 * Every refusal is a `ValidationException` on `file` (so `422 validation_failed` with `details.file`).
 */
final class ImageSanitizer
{
    /** Allowed content types and the extension the stored file gets. */
    public const TYPES = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
        'image/gif' => 'gif',
    ];

    public const THUMBNAIL_EDGE = 320;

    /** Bytes of working memory per pixel while decoding and re-encoding (truecolor decode plus the encoder's copy). */
    private const BYTES_PER_PIXEL = 9;

    private const MARKUP = '/<\?(?:php|=)|<script|<svg|<html|<!doctype\s+html|<iframe|<object|<embed/i';

    public function sanitize(string $path, int $maxBytes, int $maxDimension): SanitizedImage
    {
        $size = @filesize($path);

        if ($size === false || $size < 1) {
            throw $this->refuse(__('The file is empty or could not be read.'));
        }

        if ($size > $maxBytes) {
            throw $this->refuse(__('The file is too large (maximum :size).', ['size' => $this->humanBytes($maxBytes)]));
        }

        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);

        if (! is_string($mime) || ! isset(self::TYPES[$mime])) {
            throw $this->refuse(__('Only JPEG, PNG, WebP and GIF images can be sent.'));
        }

        [$width, $height] = $this->dimensions($path);

        if ($width > $maxDimension || $height > $maxDimension) {
            throw $this->refuse(__('The image is too large (maximum :pixels pixels on a side).', ['pixels' => $maxDimension]));
        }

        if (! $this->fitsInMemory($width, $height)) {
            throw $this->refuse(__('The image has too many pixels to be processed.'));
        }

        $raw = (string) file_get_contents($path);

        if (preg_match(self::MARKUP, $raw) === 1) {
            throw $this->refuse(__('The file is not a plain image.'));
        }

        try {
            $image = ImageManager::usingDriver(GdDriver::class)->decodeBinary($raw);

            if ($image->isAnimated()) {
                $image->removeAnimation();
            }

            $image->orient();

            $encoder = $this->encoderFor($mime);
            $main = $image->encode($encoder);
            $width = $image->width();
            $height = $image->height();

            $thumb = clone $image;
            $thumb->scaleDown(self::THUMBNAIL_EDGE, self::THUMBNAIL_EDGE);
            $thumbnail = $thumb->encode($encoder);
        } catch (Throwable) {
            throw $this->refuse(__('The image could not be read.'));
        }

        return new SanitizedImage($mime, self::TYPES[$mime], $main->toString(), $thumbnail->toString(), $width, $height);
    }

    /**
     * @return array{0: int, 1: int}
     */
    private function dimensions(string $path): array
    {
        $info = @getimagesize($path);

        if ($info === false || $info[0] < 1 || $info[1] < 1) {
            throw $this->refuse(__('The image could not be read.'));
        }

        return [$info[0], $info[1]];
    }

    private function fitsInMemory(int $width, int $height): bool
    {
        $limit = $this->memoryLimit();

        if ($limit === null) {
            return true;
        }

        return $width * $height * self::BYTES_PER_PIXEL <= $limit - memory_get_usage(true);
    }

    /** The PHP memory limit in bytes, or null when there is none. */
    private function memoryLimit(): ?int
    {
        $value = trim((string) ini_get('memory_limit'));

        if ($value === '' || $value === '-1') {
            return null;
        }

        $number = (int) $value;

        return match (strtolower(substr($value, -1))) {
            'g' => $number * 1024 ** 3,
            'm' => $number * 1024 ** 2,
            'k' => $number * 1024,
            default => $number,
        };
    }

    private function encoderFor(string $mime): EncoderInterface
    {
        return match ($mime) {
            'image/png' => new PngEncoder,
            'image/webp' => new WebpEncoder(quality: 85),
            'image/gif' => new GifEncoder,
            default => new JpegEncoder(quality: 85),
        };
    }

    private function humanBytes(int $bytes): string
    {
        return $bytes >= 1024 * 1024 ? round($bytes / 1024 / 1024, 1).' MB' : round($bytes / 1024).' KB';
    }

    private function refuse(string $message): ValidationException
    {
        return ValidationException::withMessages(['file' => [$message]]);
    }
}
