<?php

namespace Tests\Feature\Security;

use App\Domain\Chat\Services\ImageSanitizer;
use App\Domain\Chat\Services\SanitizedImage;
use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Models\Attachment;
use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ChatFixtures;
use Tests\Support\Gifs;
use Tests\Support\ImageCorpus as C;
use Tests\TestCase;

/**
 * Corpus-driven fuzzing of the image pipeline behind chat attachments and WhatsApp media (`ImageSanitizer`): broken, hostile and
 * oversized files must be REFUSED (a `422` on `file`) or re-encoded SAFELY, never crash, never take unbounded time or memory, and nothing the
 * sender controls may reach a stored path, a header or the stored bytes. The corpus is generated in code (`Tests\Support\ImageCorpus`).
 *
 * Invariants for every file that is accepted: the output is a real image of an allowed type within the limits, contains none of the
 * markers hidden in the input (PHP, HTML, EXIF / GPS text), carries no metadata segment (APP1 / APP2 / APP13 / COM, tEXt / iTXt /
 * zTXt / eXIf / iCCP, GIF comment / application extensions, WebP EXIF / XMP / ICCP) and has no bytes after its final marker.
 */
class UploadFuzzTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private const MAX_BYTES = 5 * 1024 * 1024;

    private const MAX_DIMENSION = 4096;

    private const SECONDS = 4.0;

    private const MEMORY = 100 * 1024 * 1024;

    // ---- the engine ---------------------------------------------------------------------------------------------------------------

    /** @return array{0: SanitizedImage|null, 1: float, 2: int} the result (null = refused), seconds, extra peak memory */
    private function sanitize(string $bytes): array
    {
        $path = tempnam(sys_get_temp_dir(), 'fuzz-');
        file_put_contents($path, $bytes);
        memory_reset_peak_usage();
        $before = memory_get_peak_usage(true);
        $started = microtime(true);

        try {
            $result = (new ImageSanitizer)->sanitize($path, self::MAX_BYTES, self::MAX_DIMENSION);
        } catch (ValidationException $exception) {
            $this->assertArrayHasKey('file', $exception->errors(), 'a refusal is a validation error on `file`');
            $result = null;
        } finally {
            @unlink($path);
        }

        return [$result, microtime(true) - $started, memory_get_peak_usage(true) - $before];
    }

    private function assertBounded(string $case, float $seconds, int $memory): void
    {
        $this->assertLessThan(self::SECONDS, $seconds, "{$case}: took {$seconds} s");
        $this->assertLessThan(self::MEMORY, $memory, "{$case}: used ".round($memory / 1024 / 1024).' MB more than before');
    }

    /** What an accepted file must look like. */
    private function assertSafeOutput(string $case, SanitizedImage $image): void
    {
        foreach ([$image->bytes, $image->thumbBytes] as $bytes) {
            foreach (['<?php', '<script', 'onerror', '<html', 'system($_GET', C::EXIF_MARKER, 'ns.adobe.com', 'COMMENT '] as $needle) {
                $this->assertStringNotContainsString($needle, $bytes, "{$case}: `{$needle}` survived the re-encode");
            }

            $info = getimagesizefromstring($bytes);
            $this->assertIsArray($info, "{$case}: the output is not an image");
            $this->assertContains($info['mime'], array_keys(ImageSanitizer::TYPES), $case);
            $this->assertLessThanOrEqual(self::MAX_DIMENSION, max($info[0], $info[1]), $case);

            $this->assertCleanStructure($case, $info['mime'], $bytes);
        }

        $this->assertSame(getimagesizefromstring($image->bytes)[0], $image->width, $case.': the stored width is the real one');
        $this->assertLessThanOrEqual(ImageSanitizer::THUMBNAIL_EDGE, max(getimagesizefromstring($image->thumbBytes)[0], getimagesizefromstring($image->thumbBytes)[1]), $case);
    }

    private function assertCleanStructure(string $case, string $mime, string $bytes): void
    {
        switch ($mime) {
            case 'image/png':
                $chunks = C::pngChunks($bytes);
                $this->assertSame([], array_values(array_intersect($chunks, ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'acTL', 'fcTL', 'fdAT', 'tIME'])), "{$case}: PNG metadata chunk in ".implode(',', $chunks));
                $this->assertSame([], array_values(array_filter($chunks, fn (string $chunk): bool => str_starts_with($chunk, 'TRAILING'))), "{$case}: bytes after IEND");
                break;
            case 'image/jpeg':
                $markers = C::jpegMarkers($bytes);
                $this->assertSame([], array_values(array_intersect($markers, ['E1', 'E2', 'ED', 'EC'])), "{$case}: JPEG metadata segment in ".implode(',', $markers));

                // The one comment that is allowed is the encoder's own signature (libgd), never text from the upload.
                foreach (C::jpegComments($bytes) as $comment) {
                    $this->assertMatchesRegularExpression('/^CREATOR: gd-jpeg v[\d.]+ \(using IJG JPEG v\d+\), quality = \d+\n?$/D', $comment, "{$case}: a JPEG comment that the encoder did not write");
                }

                $this->assertSame('EOI', end($markers), "{$case}: JPEG does not end at EOI (trailing data)");
                break;
            case 'image/webp':
                $this->assertSame([], array_values(array_intersect(C::webpChunks($bytes), ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'])), "{$case}: WebP metadata chunk");
                $this->assertSame(strlen($bytes), 8 + unpack('V', substr($bytes, 4, 4))[1], "{$case}: bytes after the RIFF container");
                break;
            case 'image/gif':
                $this->assertStringNotContainsString("\x21\xFE", $bytes, "{$case}: GIF comment extension");
                $this->assertStringNotContainsString("\x21\xFF", $bytes, "{$case}: GIF application extension");
                $this->assertSame("\x3B", substr($bytes, -1), "{$case}: GIF does not end at its trailer");
                break;
        }
    }

    // ---- files that must be refused ----------------------------------------------------------------------------------------------------

    /** @return iterable<string, array{string}> */
    public static function refused(): iterable
    {
        yield 'empty file' => [''];
        yield 'one byte' => ["\xFF"];
        yield 'only NULs' => [str_repeat("\0", 4096)];
        yield 'plain text' => ['hello, this is not an image'];
        yield 'PHP source' => ['<?php system($_GET["c"]); ?>'];
        yield 'HTML page' => ['<!doctype html><script>alert(1)</script>'];
        yield 'SVG with script' => ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'];
        yield 'PDF' => ["%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF"];
        yield 'zip' => ["PK\x03\x04".str_repeat("\0", 200)];
        yield 'GIF header then HTML' => [C::fakeHeader('GIF89a')];
        yield 'PNG signature then HTML' => [C::fakeHeader("\x89PNG\r\n\x1a\n")];
        yield 'JPEG signature then HTML' => [C::fakeHeader("\xFF\xD8\xFF\xE0")];
        yield 'RIFF WEBP header then HTML' => [C::fakeHeader("RIFF\x10\0\0\0WEBP")];
        yield 'BMP' => ['BM'.str_repeat("\0", 60)];
        yield 'TIFF' => ["II*\0".str_repeat("\0", 60)];
        yield 'animated GIF' => [Gifs::animated(16, 3)];
        yield 'animated GIF, pixel bomb' => [Gifs::animated(1500, 40)];
        yield 'GIF declaring 65535 x 65535' => [C::gifDeclaring(65535, 65535)];
        yield 'PNG declaring 65535 x 65535' => [C::pngDeclaring(65535, 65535)];
        yield 'PNG declaring 4097 x 10' => [C::pngDeclaring(4097, 10)];
        yield 'JPEG declaring 65500 x 65500' => [C::jpegDeclaring(65500, 65500)];
        yield 'JPEG declaring 5000 x 10' => [C::jpegDeclaring(5000, 10)];
        yield 'WebP declaring 16 million x 16 million' => [C::webpDeclaring(16_777_215, 16_777_215)];
        yield 'animated WebP' => [C::animatedWebp()];
        yield 'JPEG truncated to its first bytes' => [substr(C::jpeg(), 0, 12)];
        yield 'PNG truncated in the header' => [substr(C::png(), 0, 20)];
        yield 'WebP truncated' => [substr(C::webp(), 0, 20)];
    }

    #[DataProvider('refused')]
    public function test_a_file_that_is_not_a_safe_still_image_is_refused_quickly_and_cheaply(string $bytes): void
    {
        [$result, $seconds, $memory] = $this->sanitize($bytes);

        $this->assertNull($result, 'this file must be refused');
        $this->assertBounded('refused file', $seconds, $memory);
    }

    public function test_a_valid_image_over_the_pixel_budget_is_refused_before_it_is_decoded(): void
    {
        $limit = ini_get('memory_limit');
        ini_set('memory_limit', '256M');

        try {
            // 16.7 million pixels in 17 KB: legal in size and in edge length, far too many pixels to decode inside 256 MB.
            [$result, $seconds, $memory] = $this->sanitize(C::solidPng(4096));
        } finally {
            ini_set('memory_limit', (string) $limit);
        }

        $this->assertNull($result);
        $this->assertBounded('pixel bomb', $seconds, $memory);
    }

    public function test_a_file_over_the_size_limit_is_refused_without_being_read(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'fuzz-');
        file_put_contents($path, C::jpeg().str_repeat("\0", self::MAX_BYTES));

        try {
            (new ImageSanitizer)->sanitize($path, self::MAX_BYTES, self::MAX_DIMENSION);
            $this->fail('A file over the limit must be refused.');
        } catch (ValidationException $exception) {
            $this->assertStringContainsString('too large', $exception->errors()['file'][0]);
        } finally {
            @unlink($path);
        }
    }

    // ---- files that are re-encoded safely -------------------------------------------------------------------------------------------------

    /** @return iterable<string, array{string}> */
    public static function sanitised(): iterable
    {
        yield 'plain JPEG' => [C::jpeg()];
        yield 'plain PNG' => [C::png()];
        yield 'plain GIF' => [C::gif()];
        yield 'plain WebP' => [C::webp()];
        yield 'JPEG with EXIF GPS, XMP and a PHP comment' => [C::jpegWithMetadata()];
        yield 'PNG with tEXt / iTXt / eXIf chunks' => [C::pngWithTextChunks()];
        yield 'GIF with a comment and an XMP extension' => [C::gifWithComment()];
        yield 'JPEG with a PHP / HTML trailer' => [C::withTrailer(C::jpeg())];
        yield 'PNG with a PHP / HTML trailer' => [C::withTrailer(C::png())];
        yield 'GIF with a PHP / HTML trailer' => [C::withTrailer(C::gif())];
        yield 'WebP with a PHP / HTML trailer' => [C::withTrailer(C::webp())];
        yield 'JPEG with a trailer after a second EOI' => [C::withTrailer(C::jpeg()."\xFF\xD9", '<?php eval($_POST[1]); ?>')];
        yield 'JPEG with 3 MB of ICC profile' => [C::jpegWithIccProfile(3000)];
        yield 'PNG with a 1 GB zlib bomb in its iCCP chunk' => [C::pngWithIccBomb(1024)];
        yield 'APNG (animated PNG)' => [C::animatedPng()];
        yield 'one-frame GIF written as an animation container' => [Gifs::animated(16, 1)];
    }

    #[DataProvider('sanitised')]
    public function test_a_hostile_file_with_an_image_inside_comes_out_as_a_clean_re_encoded_image_or_is_refused(string $bytes): void
    {
        [$result, $seconds, $memory] = $this->sanitize($bytes);

        $this->assertBounded('re-encode', $seconds, $memory);

        if ($result !== null) {
            $this->assertSafeOutput('accepted file', $result);
        }
    }

    public function test_the_plain_images_and_the_metadata_polyglots_are_actually_accepted(): void
    {
        foreach ([C::jpeg(), C::png(), C::gif(), C::webp(), C::jpegWithMetadata(), C::pngWithTextChunks(), C::gifWithComment(), C::withTrailer(C::jpeg()), C::withTrailer(C::png()), C::animatedPng()] as $index => $bytes) {
            [$result] = $this->sanitize($bytes);

            $this->assertNotNull($result, "valid image #{$index} must not be refused");
        }
    }

    // ---- truncation and corruption sweeps ------------------------------------------------------------------------------------------------

    /** @return iterable<string, array{string, float}> */
    public static function truncations(): iterable
    {
        foreach (['jpeg' => C::jpeg(60, 40), 'png' => C::png(60, 40), 'gif' => C::gif(), 'webp' => C::webp(60, 40)] as $type => $file) {
            foreach ([0.05, 0.2, 0.5, 0.8, 0.97, 0.999] as $fraction) {
                yield "{$type} cut at ".($fraction * 100).'%' => [$file, $fraction];
            }
        }
    }

    #[DataProvider('truncations')]
    public function test_a_truncated_image_is_refused_or_comes_out_clean(string $file, float $fraction): void
    {
        [$result, $seconds, $memory] = $this->sanitize(C::truncated($file, $fraction));

        $this->assertBounded('truncated', $seconds, $memory);

        if ($result !== null) {
            $this->assertSafeOutput('truncated', $result);
        }
    }

    public function test_hundreds_of_byte_flips_never_crash_never_hang_and_never_leak(): void
    {
        $files = ['jpeg' => C::jpegWithMetadata(), 'png' => C::pngWithTextChunks(), 'gif' => C::gifWithComment(), 'webp' => C::webp(50, 50)];
        $accepted = 0;
        $refused = 0;

        foreach ($files as $type => $file) {
            for ($seed = 1; $seed <= 60; $seed++) {
                [$result, $seconds, $memory] = $this->sanitize(C::corrupted($file, $seed, $seed % 5 + 1, 12));

                $this->assertBounded("{$type} flips #{$seed}", $seconds, $memory);

                if ($result === null) {
                    $refused++;

                    continue;
                }

                $accepted++;
                $this->assertSafeOutput("{$type} flips #{$seed}", $result);
            }
        }

        $this->assertGreaterThan(0, $accepted, 'some mutations stay decodable');
        $this->assertGreaterThan(0, $refused, 'some mutations are refused');
    }

    // ---- through the API: nothing the sender controls reaches a path, a header or the stored name unsafely --------------------------------------------

    /** @return iterable<string, array{string}> */
    public static function hostileNames(): iterable
    {
        yield 'php extension' => ['shell.php'];
        yield 'double extension' => ['photo.php.jpg'];
        yield 'jpg then php' => ['photo.jpg.php'];
        yield 'null byte' => ["photo.php\0.jpg"];
        yield 'path traversal' => ['../../../../etc/passwd'];
        yield 'absolute path' => ['/etc/cron.d/evil'];
        yield 'windows path' => ['..\\..\\windows\\system32\\evil.exe'];
        yield 'right-to-left override' => ["photo\u{202E}gpj.exe"];
        yield 'CRLF header injection' => ["a.jpg\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>"];
        yield 'quote and semicolon' => ['a";filename="evil.html'];
        yield 'very long' => [str_repeat('a', 5000).'.png'];
        yield 'only dots' => ['....'];
        yield 'markup' => ['<script>alert(1)</script>.png'];
    }

    #[DataProvider('hostileNames')]
    public function test_a_hostile_file_name_never_reaches_the_stored_path_the_headers_or_the_name_unsanitised(string $name): void
    {
        Storage::fake('local');
        [$widget, $category] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $chat = $this->activeChat($token, $category, $this->availableAgent($category));
        $upload = UploadedFile::fake()->createWithContent($name, C::png(30, 20));

        $response = $this->withHeaders($this->bearer($token))->post('/api/v1/public/conversations/'.$chat->ulid.'/attachments', ['file' => $upload], ['Accept' => 'application/json']);

        $response->assertCreated();
        $attachment = Attachment::query()->latest('id')->firstOrFail();

        $this->assertMatchesRegularExpression('#^chat/attachments/\d{4}/\d{2}/[a-z0-9]{40}\.png$#D', $attachment->path, 'the stored path is random and typed by the server');
        $this->assertMatchesRegularExpression('#^chat/attachments/\d{4}/\d{2}/[a-z0-9]{40}_t\.png$#D', (string) $attachment->thumb_path);
        $this->assertSame('image/png', $attachment->mime);
        $this->assertDoesNotMatchRegularExpression('/[\x00-\x1f<>"\'\\\\\/;:]/u', (string) $attachment->original_name, 'the stored display name is reduced to harmless characters');
        $this->assertLessThanOrEqual(120, mb_strlen((string) $attachment->original_name));
        $this->assertStringNotContainsString('..', str_replace('...', '', (string) $attachment->original_name) ?: '');

        Storage::disk('local')->assertExists($attachment->path);
        $this->assertSame([], array_values(array_filter(Storage::disk('local')->allFiles(), fn (string $file): bool => ! str_starts_with($file, 'chat/attachments/'))), 'nothing was written outside the attachments folder');

        // The file is served with a server-chosen type and no sender-controlled header.
        $signed = $response->json('data.url');
        $this->assertIsString($signed);
        $served = $this->get($signed);

        $served->assertOk();
        $this->assertSame('image/png', $served->headers->get('Content-Type'));
        $this->assertSame('nosniff', $served->headers->get('X-Content-Type-Options'));
        $this->assertSame("default-src 'none'; sandbox", $served->headers->get('Content-Security-Policy'));
        $this->assertStringNotContainsString($name === '' ? "\0" : substr(trim($name), 0, 12), (string) $served->headers->get('Content-Disposition'));
        $this->assertNull($served->headers->get('Set-Cookie'));
        $this->assertStringNotContainsString("\r", implode('', array_map(fn ($values): string => implode('', (array) $values), $served->headers->allPreserveCase())));
    }

    public function test_the_client_declared_type_and_extension_are_ignored_the_content_decides(): void
    {
        Storage::fake('local');
        [$widget, $category] = $this->chatWidget();
        $token = $this->visitorSession($widget);
        $chat = $this->activeChat($token, $category, $this->availableAgent($category));
        $post = fn (UploadedFile $file) => $this->withHeaders($this->bearer($token))->post('/api/v1/public/conversations/'.$chat->ulid.'/attachments', ['file' => $file], ['Accept' => 'application/json']);

        // PHP dressed as a JPEG, with the image MIME type the client claims.
        $php = UploadedFile::fake()->createWithContent('photo.jpg', C::PHP_MARKER);
        $post($php)->assertUnprocessable()->assertJsonValidationErrors('file', 'error.details');

        // A real PNG called .php, .svg or .html is a PNG.
        foreach (['picture.php', 'picture.svg', 'picture.html', 'picture'] as $name) {
            $post(UploadedFile::fake()->createWithContent($name, C::png(20, 20)))->assertCreated();
        }

        $this->assertSame(['image/png'], Attachment::query()->distinct()->pluck('mime')->all());
        $this->assertSame(0, count(array_filter(Storage::disk('local')->allFiles(), fn (string $file): bool => ! preg_match('/\.(png)$/', $file))));
    }

    public function test_whatsapp_media_goes_through_the_same_pipeline(): void
    {
        Storage::fake('local');
        $store = app(WaMediaStore::class);
        $chat = WaChat::factory()->create();
        $stored = [];

        foreach (['not an image' => C::PHP_MARKER, 'gif bomb' => Gifs::animated(1500, 40), 'huge canvas' => C::pngDeclaring(65535, 65535), 'plain' => C::jpegWithMetadata(), 'polyglot' => C::withTrailer(C::png())] as $label => $bytes) {
            $message = WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'type' => 'image']);
            $stored[$label] = $store->store($message, $bytes, '../../'.$label.'.php');
        }

        $this->assertSame(['not an image' => false, 'gif bomb' => false, 'huge canvas' => false, 'plain' => true, 'polyglot' => true], $stored);

        foreach (WaMessage::query()->whereNotNull('media_path')->get() as $message) {
            $this->assertMatchesRegularExpression('#^whatsapp/media/\d{4}/\d{2}/[a-z0-9]{40}\.(jpg|png)$#D', (string) $message->media_path);
            $this->assertStringNotContainsString('/', (string) $message->media_filename);
            $bytes = Storage::disk('local')->get((string) $message->media_path);
            $this->assertStringNotContainsString(C::EXIF_MARKER, $bytes);
            $this->assertStringNotContainsString('<?php', $bytes);
        }

        $this->assertSame(2, WaMessage::query()->whereNotNull('media_path')->count());
        $this->assertCount(2, Storage::disk('local')->allFiles('whatsapp'));
    }
}
