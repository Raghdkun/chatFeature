<?php

namespace Tests\Support;

/**
 * Hostile and broken image files, generated in code (no binary blobs in the repository): truncations, byte flips, polyglots (a real
 * image followed by or hiding markup), declared-huge canvases, metadata (EXIF / XMP / comments / ICC) and zlib bombs, animated variants.
 * Plus small parsers that list what an output file really contains, so a test can assert "no metadata, no trailing data".
 */
final class ImageCorpus
{
    public const PHP_MARKER = '<?php system($_GET["c"]); ?>';

    public const HTML_MARKER = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';

    public const EXIF_MARKER = 'SECRET-GPS-48.8584N-2.2945E';

    // ---- valid base images --------------------------------------------------------------------------------------------------------

    public static function jpeg(int $width = 40, int $height = 30): string
    {
        $image = self::gradient($width, $height);
        ob_start();
        imagejpeg($image, null, 88);

        return (string) ob_get_clean();
    }

    public static function png(int $width = 40, int $height = 30): string
    {
        $image = self::gradient($width, $height);
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    public static function gif(): string
    {
        return Gifs::still(24);
    }

    public static function webp(int $width = 40, int $height = 30): string
    {
        $image = self::gradient($width, $height);
        ob_start();
        imagewebp($image, null, 80);

        return (string) ob_get_clean();
    }

    private static function gradient(int $width, int $height): \GdImage
    {
        $image = imagecreatetruecolor($width, $height);

        for ($x = 0; $x < $width; $x++) {
            for ($y = 0; $y < $height; $y++) {
                imagesetpixel($image, $x, $y, (int) imagecolorallocate($image, ($x * 6) % 256, ($y * 8) % 256, ($x + $y) % 256));
            }
        }

        return $image;
    }

    // ---- breakage -----------------------------------------------------------------------------------------------------------------

    /** The file cut after `$fraction` of its bytes (0 < fraction < 1), or after `$bytes` when given. */
    public static function truncated(string $file, float $fraction): string
    {
        return substr($file, 0, max(1, (int) floor(strlen($file) * $fraction)));
    }

    /** Deterministic byte corruption: `$flips` bytes after the first `$protect` bytes are XOR-ed. */
    public static function corrupted(string $file, int $seed, int $flips = 8, int $protect = 4): string
    {
        mt_srand($seed);
        $length = strlen($file);

        for ($i = 0; $i < $flips && $length > $protect + 1; $i++) {
            $position = mt_rand($protect, $length - 1);
            $file[$position] = chr(ord($file[$position]) ^ mt_rand(1, 255));
        }

        return $file;
    }

    // ---- polyglots and metadata -----------------------------------------------------------------------------------------------------

    public static function jpegWithMetadata(): string
    {
        $jpeg = self::jpeg();
        $exif = "Exif\0\0MM\x00\x2A\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00".self::EXIF_MARKER;
        $xmp = "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:li>".self::EXIF_MARKER.'</rdf:li>'.self::HTML_MARKER.'</x:xmpmeta>';
        $comment = 'COMMENT '.self::PHP_MARKER;

        return substr($jpeg, 0, 2)
            ."\xFF\xE1".pack('n', strlen($exif) + 2).$exif
            ."\xFF\xE1".pack('n', strlen($xmp) + 2).$xmp
            ."\xFF\xFE".pack('n', strlen($comment) + 2).$comment
            .substr($jpeg, 2);
    }

    public static function withTrailer(string $file, string $trailer = self::PHP_MARKER.self::HTML_MARKER): string
    {
        return $file.$trailer;
    }

    public static function pngWithTextChunks(): string
    {
        $png = self::png();
        $insert = self::pngChunk('tEXt', 'Comment'."\0".self::HTML_MARKER)
            .self::pngChunk('iTXt', "XML:com.adobe.xmp\0\0\0\0\0".self::EXIF_MARKER.self::PHP_MARKER)
            .self::pngChunk('eXIf', "MM\x00\x2A\x00\x00\x00\x08".self::EXIF_MARKER);

        return substr($png, 0, 33).$insert.substr($png, 33);
    }

    public static function gifWithComment(): string
    {
        $gif = self::gif();
        $flags = ord($gif[10]);
        $position = 13 + (($flags & 0x80) !== 0 ? 3 * (1 << (($flags & 0x07) + 1)) : 0);
        $comment = "\x21\xFE".chr(strlen(self::PHP_MARKER)).self::PHP_MARKER."\x00";
        $xmp = "\x21\xFF\x0BXMP DataXMP".chr(strlen(self::HTML_MARKER)).self::HTML_MARKER."\x00";

        return substr($gif, 0, $position).$comment.$xmp.substr($gif, $position);
    }

    /** Text that starts like an image header and continues as markup: not an image. */
    public static function fakeHeader(string $header): string
    {
        return $header.'<html><body>'.self::HTML_MARKER.'</body></html>'.self::PHP_MARKER;
    }

    // ---- animation ----------------------------------------------------------------------------------------------------------------

    public static function animatedPng(): string
    {
        $png = self::png(16, 16);
        $acTL = self::pngChunk('acTL', pack('NN', 2, 0));
        $fcTL = self::pngChunk('fcTL', pack('NNNNNnnCC', 0, 16, 16, 0, 0, 1, 10, 0, 0));
        $fdAT = self::pngChunk('fdAT', pack('N', 1).str_repeat("\x00", 40));

        return substr($png, 0, 33).$acTL.$fcTL.substr($png, 33, -12).$fdAT.substr($png, -12);
    }

    /** A RIFF WebP that announces an animation (VP8X flag + ANIM + ANMF) with frame data that is not decodable. */
    public static function animatedWebp(): string
    {
        $vp8x = pack('C', 0x02)."\x00\x00\x00".self::le24(15).self::le24(15);
        $anim = pack('V', 0xFFFFFFFF).pack('v', 0);
        $anmf = str_repeat("\x00", 16).'VP8 '.pack('V', 4)."\x00\x00\x00\x00";
        $body = 'WEBP'.self::riffChunk('VP8X', $vp8x).self::riffChunk('ANIM', $anim).self::riffChunk('ANMF', $anmf);

        return 'RIFF'.pack('V', strlen($body)).$body;
    }

    // ---- declared-huge canvases and bombs ---------------------------------------------------------------------------------------------

    /** A PNG whose header declares `$width` x `$height` grayscale 1-bit pixels, with a tiny (valid for the first rows) pixel stream. */
    public static function pngDeclaring(int $width, int $height): string
    {
        $ihdr = pack('NNCCCCC', $width, $height, 1, 0, 0, 0, 0);
        $idat = (string) gzcompress(str_repeat("\x00", 513 * 4), 9);

        return "\x89PNG\r\n\x1a\n".self::pngChunk('IHDR', $ihdr).self::pngChunk('IDAT', $idat).self::pngChunk('IEND', '');
    }

    /** A VALID grayscale 1-bit PNG of `$side` x `$side` (4096 x 4096 is 16.7 million pixels in about 17 KB). */
    public static function solidPng(int $side): string
    {
        $row = "\x00".str_repeat("\x00", intdiv($side + 7, 8));
        $idat = (string) gzcompress(str_repeat($row, $side), 9);

        return "\x89PNG\r\n\x1a\n".self::pngChunk('IHDR', pack('NNCCCCC', $side, $side, 1, 0, 0, 0, 0)).self::pngChunk('IDAT', $idat).self::pngChunk('IEND', '');
    }

    /** A real JPEG whose SOF header is rewritten to declare `$width` x `$height`. */
    public static function jpegDeclaring(int $width, int $height): string
    {
        $jpeg = self::jpeg();
        $position = strpos($jpeg, "\xFF\xC0");

        if ($position === false) {
            return $jpeg;
        }

        return substr($jpeg, 0, $position + 5).pack('nn', $height, $width).substr($jpeg, $position + 9);
    }

    public static function gifDeclaring(int $width, int $height): string
    {
        $gif = self::gif();

        return substr($gif, 0, 6).pack('vv', $width, $height).substr($gif, 10);
    }

    public static function webpDeclaring(int $width, int $height): string
    {
        $vp8x = pack('C', 0x00)."\x00\x00\x00".self::le24($width - 1).self::le24($height - 1);
        $body = 'WEBP'.self::riffChunk('VP8X', $vp8x).self::riffChunk('VP8 ', str_repeat("\x00", 10));

        return 'RIFF'.pack('V', strlen($body)).$body;
    }

    /** A valid PNG with an iCCP chunk whose zlib stream inflates to about `$inflatedMegabytes` MB of zeros (a decompression bomb in metadata). */
    public static function pngWithIccBomb(int $inflatedMegabytes): string
    {
        $png = self::png();
        $deflate = deflate_init(ZLIB_ENCODING_DEFLATE, ['level' => 9]);
        $stream = '';

        for ($i = 0; $i < $inflatedMegabytes; $i++) {
            $stream .= deflate_add($deflate, str_repeat("\x00", 1024 * 1024), ZLIB_NO_FLUSH);
        }

        $stream .= deflate_add($deflate, '', ZLIB_FINISH);
        $chunk = self::pngChunk('iCCP', "icc\0\0".$stream);

        return substr($png, 0, 33).$chunk.substr($png, 33);
    }

    /** A JPEG with `$kilobytes` KB of ICC profile spread over APP2 segments (the 64 KB segment limit forces many). */
    public static function jpegWithIccProfile(int $kilobytes): string
    {
        $jpeg = self::jpeg();
        $segments = '';
        $chunks = max(1, intdiv($kilobytes, 63));

        for ($i = 1; $i <= $chunks; $i++) {
            $payload = "ICC_PROFILE\0".chr($i).chr($chunks).str_repeat("\x00", 63 * 1024);
            $segments .= "\xFF\xE2".pack('n', strlen($payload) + 2).$payload;
        }

        return substr($jpeg, 0, 2).$segments.substr($jpeg, 2);
    }

    // ---- inspecting an output file ------------------------------------------------------------------------------------------------

    /** @return list<string> the chunk types of a PNG, in order; fails when bytes follow IEND */
    public static function pngChunks(string $png): array
    {
        $types = [];
        $offset = 8;

        while ($offset + 8 <= strlen($png)) {
            $length = unpack('N', substr($png, $offset, 4))[1];
            $type = substr($png, $offset + 4, 4);
            $types[] = $type;
            $offset += 12 + $length;

            if ($type === 'IEND') {
                break;
            }
        }

        if ($offset !== strlen($png)) {
            $types[] = 'TRAILING:'.(strlen($png) - $offset);
        }

        return $types;
    }

    /** @return list<string> the JPEG markers (hex) before the scan, plus `TRAILING:n` when bytes follow the final EOI */
    public static function jpegMarkers(string $jpeg): array
    {
        $markers = [];
        $offset = 2;
        $length = strlen($jpeg);

        while ($offset + 4 <= $length) {
            if ($jpeg[$offset] !== "\xFF") {
                break;
            }

            $marker = ord($jpeg[$offset + 1]);
            $markers[] = sprintf('%02X', $marker);

            if ($marker === 0xDA) {
                break;
            }

            $offset += 2 + unpack('n', substr($jpeg, $offset + 2, 2))[1];
        }

        if (! str_ends_with($jpeg, "\xFF\xD9")) {
            $markers[] = 'NO-EOI';
        } else {
            $markers[] = 'EOI';
        }

        return $markers;
    }

    /** @return list<string> the text of every COM segment of a JPEG (libgd writes its own `CREATOR: gd-jpeg ...` one) */
    public static function jpegComments(string $jpeg): array
    {
        $comments = [];
        $offset = 2;

        while ($offset + 4 <= strlen($jpeg) && $jpeg[$offset] === "\xFF") {
            $marker = ord($jpeg[$offset + 1]);
            $length = unpack('n', substr($jpeg, $offset + 2, 2))[1];

            if ($marker === 0xFE) {
                $comments[] = substr($jpeg, $offset + 4, $length - 2);
            }

            if ($marker === 0xDA) {
                break;
            }

            $offset += 2 + $length;
        }

        return $comments;
    }

    /** @return list<string> the RIFF chunk types of a WebP */
    public static function webpChunks(string $webp): array
    {
        $types = [];
        $offset = 12;

        while ($offset + 8 <= strlen($webp)) {
            $size = unpack('V', substr($webp, $offset + 4, 4))[1];
            $types[] = substr($webp, $offset, 4);
            $offset += 8 + $size + ($size % 2);
        }

        return $types;
    }

    public static function pngChunk(string $type, string $data): string
    {
        return pack('N', strlen($data)).$type.$data.pack('N', crc32($type.$data));
    }

    private static function riffChunk(string $type, string $data): string
    {
        return $type.pack('V', strlen($data)).$data.(strlen($data) % 2 === 1 ? "\x00" : '');
    }

    private static function le24(int $value): string
    {
        return chr($value & 0xFF).chr(($value >> 8) & 0xFF).chr(($value >> 16) & 0xFF);
    }
}
