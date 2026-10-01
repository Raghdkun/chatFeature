<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Actions\UploadAttachment;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\Support\Gifs;
use Tests\TestCase;

/**
 * Image uploads (decision P4-D9): judged by content, re-encoded, EXIF stripped, thumbnail, private disk with random paths, signed
 * URLs, and every way a hostile file could try to get through.
 */
class AttachmentApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private IssuedVisitorToken $token;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->token = $this->visitorSession($this->widget);
        $this->chat = $this->activeChat($this->token, $this->billing, User::factory()->agent()->create());
    }

    private function upload(UploadedFile $file, ?IssuedVisitorToken $token = null, ?Conversation $chat = null): TestResponse
    {
        return $this->withToken(($token ?? $this->token)->plaintext)
            ->post('/api/v1/public/conversations/'.($chat ?? $this->chat)->ulid.'/attachments', ['file' => $file], ['Accept' => 'application/json']);
    }

    private function content(string $bytes, string $name, ?string $mime = null): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $bytes)->mimeType($mime ?? 'image/png');
    }

    private function pngBytes(int $width = 20, int $height = 20): string
    {
        $image = imagecreatetruecolor($width, $height);
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    public function test_an_image_is_re_encoded_stored_privately_and_described_without_internals(): void
    {
        $response = $this->upload($this->pngUpload('..\\..\\etc\\holiday<script>.png', 40, 30))
            ->assertCreated()
            ->assertJsonPath('data.mime', 'image/png')
            ->assertJsonPath('data.width', 40)
            ->assertJsonPath('data.height', 30)
            ->assertJsonStructure(['data' => ['ulid', 'mime', 'size', 'width', 'height', 'url', 'thumbUrl']]);

        $this->assertSame(['ulid', 'mime', 'size', 'width', 'height', 'url', 'thumbUrl'], array_keys($response->json('data')));

        $attachment = Attachment::query()->sole();
        $this->assertSame($this->chat->id, $attachment->conversation_id);
        $this->assertNull($attachment->message_id);
        $this->assertSame('visitor', $attachment->uploader_type->value);
        $this->assertSame('local', $attachment->disk);
        $this->assertMatchesRegularExpression('#^chat/attachments/\d{4}/\d{2}/[a-z0-9]{40}\.png$#', $attachment->path);
        $this->assertMatchesRegularExpression('#^chat/attachments/\d{4}/\d{2}/[a-z0-9]{40}_t\.png$#', (string) $attachment->thumb_path);
        Storage::disk('local')->assertExists([$attachment->path, $attachment->thumb_path]);
        $this->assertSame(hash('sha256', Storage::disk('local')->get($attachment->path)), $attachment->sha256);
        $this->assertSame(strlen(Storage::disk('local')->get($attachment->path)), $attachment->size);
        $this->assertSame('holidayscript.png', $attachment->original_name);

        // Neither the storage path, the hash nor the client's file name appear in the payload.
        $body = (string) $response->getContent();
        foreach ([$attachment->path, $attachment->sha256, 'holiday', 'etc'] as $secret) {
            $this->assertStringNotContainsString($secret, $body);
        }

        // Random paths: two uploads of the same file never share one.
        $this->upload($this->pngUpload())->assertCreated();
        $this->assertCount(2, array_unique(Attachment::query()->pluck('path')->all()));
    }

    public function test_the_signed_urls_serve_the_image_and_its_thumbnail(): void
    {
        $data = $this->upload($this->pngUpload('big.png', 800, 600))->assertCreated()->json('data');

        $full = $this->get($data['url'])->assertOk();
        $this->assertSame('image/png', $full->headers->get('Content-Type'));
        $this->assertSame('nosniff', $full->headers->get('X-Content-Type-Options'));
        $this->assertStringContainsString("default-src 'none'", (string) $full->headers->get('Content-Security-Policy'));
        $this->assertStringNotContainsString('big.png', (string) $full->headers->get('Content-Disposition'));
        $this->assertSame([800, 600], array_slice(getimagesizefromstring($full->streamedContent()), 0, 2));

        $thumb = $this->get($data['thumbUrl'])->assertOk();
        [$width, $height] = getimagesizefromstring($thumb->streamedContent());
        $this->assertSame([320, 240], [$width, $height]);

        // No bearer token is involved: the signature is the credential.
        $this->assertStringContainsString('signature=', $data['url']);
        $this->assertStringContainsString('thumb=1', $data['thumbUrl']);
    }

    public function test_a_signed_url_cannot_be_tampered_with_or_borrowed(): void
    {
        $first = $this->upload($this->pngUpload())->assertCreated()->json('data');
        $second = $this->upload($this->pngUpload())->assertCreated()->json('data');

        // Unsigned, altered signature, signature of another attachment, a dropped / added query parameter.
        $this->get('/api/v1/public/attachments/'.$first['ulid'])->assertForbidden();
        $this->get(preg_replace('/signature=[a-f0-9]+/', 'signature='.str_repeat('0', 64), $first['url']))->assertForbidden();
        $this->get(str_replace($first['ulid'], $second['ulid'], $first['url']))->assertForbidden();
        $this->get(str_replace('thumb=1&', '', $first['thumbUrl']))->assertForbidden();
        $this->get($first['url'].'&thumb=1')->assertForbidden();
        $this->get($first['thumbUrl'])->assertOk();

        // The signature is short-lived.
        $this->travel(31)->minutes();
        $this->get($first['url'])->assertForbidden();
    }

    public function test_a_valid_signature_for_a_missing_file_is_not_found(): void
    {
        $data = $this->upload($this->pngUpload())->assertCreated()->json('data');
        $attachment = Attachment::query()->sole();
        Storage::disk('local')->delete($attachment->path);

        $this->get($data['url'])->assertNotFound();
        $this->get($data['thumbUrl'])->assertOk();
    }

    public function test_jpeg_exif_is_stripped_by_the_re_encode(): void
    {
        $upload = $this->jpegWithExif('SECRET-GPS-MARKER');
        $this->assertStringContainsString('SECRET-GPS-MARKER', (string) file_get_contents($upload->getRealPath()));

        $this->upload($upload)->assertCreated()->assertJsonPath('data.mime', 'image/jpeg');

        $attachment = Attachment::query()->sole();
        foreach ([$attachment->path, $attachment->thumb_path] as $path) {
            $stored = Storage::disk('local')->get($path);
            $this->assertStringNotContainsString('SECRET-GPS-MARKER', $stored);
            $this->assertStringNotContainsString('Exif', $stored);
            $this->assertSame('image/jpeg', getimagesizefromstring($stored)['mime']);
        }
    }

    public function test_webp_and_gif_images_are_accepted(): void
    {
        $image = imagecreatetruecolor(16, 16);
        ob_start();
        imagewebp($image);
        $webp = (string) ob_get_clean();
        ob_start();
        imagegif($image);
        $gif = (string) ob_get_clean();

        $this->upload($this->content($webp, 'a.webp', 'image/webp'))->assertCreated()->assertJsonPath('data.mime', 'image/webp');
        $this->upload($this->content($gif, 'a.gif', 'image/gif'))->assertCreated()->assertJsonPath('data.mime', 'image/gif');
    }

    public function test_the_content_decides_not_the_name_or_the_declared_type(): void
    {
        $svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>';
        $cases = [
            'php source as png' => $this->content('<?php system($_GET["c"]);', 'shell.png'),
            'html as jpeg' => $this->content('<html><script>alert(1)</script></html>', 'x.jpg', 'image/jpeg'),
            'svg as png' => $this->content($svg, 'x.png', 'image/png'),
            'svg as svg' => $this->content($svg, 'x.svg', 'image/svg+xml'),
            'plain text' => $this->content(str_repeat('hello ', 50), 'x.png'),
            'pdf' => $this->content("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", 'x.png'),
            'zip' => $this->content("PK\x03\x04".str_repeat("\0", 64), 'x.png'),
            'png header, garbage body' => $this->content("\x89PNG\r\n\x1a\n".str_repeat('x', 100), 'x.png'),
            'empty' => $this->content('', 'x.png'),
        ];

        foreach ($cases as $label => $file) {
            $this->upload($file)->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        }

        $this->assertSame(0, Attachment::query()->count(), 'nothing was stored');
        $this->assertSame([], Storage::disk('local')->allFiles());
    }

    public function test_markup_hidden_in_an_image_does_not_get_it_refused_but_never_survives_the_re_encode(): void
    {
        $png = $this->pngBytes();
        $payloads = ['<?php echo 1; ?>', '<?= $x ?>', '<script>alert(1)</script>', '<svg onload=alert(1)>', '<HTML><body>'];

        // Trailing data after the image.
        foreach ($payloads as $payload) {
            $this->upload($this->content($png.$payload, 'polyglot.png'))->assertCreated();
        }

        // A PNG text chunk and a JPEG comment segment.
        $text = 'Comment'.' '.implode('', $payloads);
        $chunk = pack('N', strlen($text)).'tEXt'.$text.pack('N', crc32('tEXt'.$text));
        $this->upload($this->content(substr($png, 0, 33).$chunk.substr($png, 33), 'text.png'))->assertCreated();

        $image = imagecreatetruecolor(8, 8);
        ob_start();
        imagejpeg($image);
        $jpeg = (string) ob_get_clean();
        $comment = implode('', $payloads);
        $this->upload($this->content(substr($jpeg, 0, 2)."\xFF\xFE".pack('n', strlen($comment) + 2).$comment.substr($jpeg, 2), 'c.jpg', 'image/jpeg'))->assertCreated();

        $stored = Attachment::query()->get();
        $this->assertCount(7, $stored);

        foreach ($stored as $attachment) {
            foreach ([$attachment->path, $attachment->thumb_path] as $path) {
                $bytes = Storage::disk('local')->get($path);
                $this->assertNotNull(getimagesizefromstring($bytes));
                foreach (['<?', '<script', '<svg', '<html', 'alert('] as $needle) {
                    $this->assertStringNotContainsStringIgnoringCase($needle, $bytes);
                }
            }
        }
    }

    public function test_a_noisy_photo_whose_compressed_bytes_happen_to_contain_markup_is_accepted(): void
    {
        // High-entropy data: build an image whose PNG (stored, uncompressed deflate blocks) carries `<?=` and `<svg` as pixel bytes.
        $width = 64;
        $height = 8;
        $raw = '';

        for ($y = 0; $y < $height; $y++) {
            $row = "\0".str_pad('<?=<svg<script<html', $width * 3, "\x7F");
            $raw .= $row;
        }

        $zlib = "\x78\x01\x01".pack('v', strlen($raw)).pack('v', ~strlen($raw) & 0xFFFF).$raw.pack('N', hexdec(hash('adler32', $raw)));
        $header = pack('N', $width).pack('N', $height)."\x08\x02\x00\x00\x00";
        $png = "\x89PNG\r\n\x1a\n"
            .pack('N', 13).'IHDR'.$header.pack('N', crc32('IHDR'.$header))
            .pack('N', strlen($zlib)).'IDAT'.$zlib.pack('N', crc32('IDAT'.$zlib))
            .pack('N', 0).'IEND'.pack('N', crc32('IEND'));
        $this->assertStringContainsString('<?=<svg', $png);

        $this->upload($this->content($png, 'photo.png'))->assertCreated();

        $attachment = Attachment::query()->sole();
        $this->assertStringNotContainsString('<?=', Storage::disk('local')->get($attachment->path));
        $this->assertStringNotContainsString('<svg', Storage::disk('local')->get($attachment->path));
    }

    public function test_an_animated_gif_is_refused_before_it_is_decoded(): void
    {
        // 40 frames of 1500 x 1500: a few KB of file, but 90 MB if the decoder keeps every canvas.
        $bomb = Gifs::animated(1500, 40);
        $this->assertLessThan(200 * 1024, strlen($bomb));

        $this->upload($this->content($bomb, 'bomb.gif', 'image/gif'))
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['file']]]);
        $this->upload($this->content(Gifs::animated(16, 2), 'two.gif', 'image/gif'))->assertStatus(422);

        $this->assertSame(0, Attachment::query()->count());
        $this->assertSame([], Storage::disk('local')->allFiles());

        // A still GIF is fine, and stays a GIF.
        $this->upload($this->content(Gifs::still(), 'still.gif', 'image/gif'))->assertCreated()->assertJsonPath('data.mime', 'image/gif');
    }

    public function test_the_size_limit_is_enforced(): void
    {
        settings()->set('chat.attachment_max_bytes', 10240);

        $noise = imagecreatetruecolor(200, 200);
        for ($x = 0; $x < 200; $x++) {
            for ($y = 0; $y < 200; $y++) {
                imagesetpixel($noise, $x, $y, random_int(0, 0xFFFFFF));
            }
        }
        ob_start();
        imagepng($noise);
        $big = (string) ob_get_clean();
        $this->assertGreaterThan(10240, strlen($big));

        $this->upload($this->content($big, 'big.png'))->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['file']]]);
        $this->assertSame(0, Attachment::query()->count());

        $this->upload($this->pngUpload())->assertCreated();
    }

    public function test_the_dimension_limit_is_enforced(): void
    {
        settings()->set('chat.attachment_max_dimension', 256);

        $this->upload($this->pngUpload('wide.png', 300, 20))->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['file']]]);
        $this->upload($this->pngUpload('tall.png', 20, 300))->assertStatus(422);
        $this->upload($this->pngUpload('ok.png', 256, 256))->assertCreated();
        $this->assertSame(1, Attachment::query()->count());
    }

    public function test_an_image_that_would_not_fit_in_memory_is_refused_before_decoding(): void
    {
        // Headroom of 24 MB above what the test already uses: a 16-megapixel decode cannot fit.
        $previous = ini_set('memory_limit', (string) (memory_get_usage(true) + 24 * 1024 * 1024));

        try {
            settings()->set('chat.attachment_max_dimension', 8192);
            // 4000 x 4000 = 16 million pixels: far more than 64 MB can decode.
            $header = pack('N', 4000).pack('N', 4000);
            $png = "\x89PNG\r\n\x1a\n".pack('N', 13).'IHDR'.$header."\x08\x02\x00\x00\x00".pack('N', crc32('IHDR'.$header."\x08\x02\x00\x00\x00")).pack('N', 0).'IEND'.pack('N', crc32('IEND'));

            $this->upload($this->content($png, 'bomb.png'))->assertStatus(422);
        } finally {
            ini_set('memory_limit', (string) $previous);
        }
    }

    public function test_a_failed_php_upload_and_a_missing_file_are_refused(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'up');
        file_put_contents($path, $this->pngBytes());
        $broken = new UploadedFile($path, 'photo.png', 'image/png', UPLOAD_ERR_PARTIAL, true);

        $this->upload($broken)->assertStatus(422);
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/attachments", [])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['file']]]);
        $this->withToken($this->token->plaintext)->postJson("/api/v1/public/conversations/{$this->chat->ulid}/attachments", ['file' => 'text'])->assertStatus(422);
    }

    public function test_pending_uploads_are_capped_per_conversation(): void
    {
        config(['chat.rate_limits.public_upload_session' => 100]);

        foreach (range(1, UploadAttachment::MAX_PENDING) as $i) {
            $this->upload($this->pngUpload())->assertCreated();
        }

        $this->upload($this->pngUpload())->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['file']]]);
        $this->assertSame(UploadAttachment::MAX_PENDING, Attachment::query()->count());
    }

    public function test_the_widget_can_switch_attachments_off_for_visitors(): void
    {
        $config = $this->widget->config;
        $config['features']['attachments'] = false;
        $this->widget->forceFill(['config' => $config])->save();

        $this->upload($this->pngUpload())->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');
    }

    public function test_only_an_active_live_chat_takes_uploads(): void
    {
        $queuedToken = $this->visitorSession($this->widget);
        $queued = $this->queuedChat($queuedToken, $this->billing);
        $this->upload($this->pngUpload(), $queuedToken, $queued)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');

        $this->chat->forceFill(['status' => 'ended'])->save();
        $this->upload($this->pngUpload())->assertStatus(409);
    }

    public function test_uploads_are_rate_limited_per_session(): void
    {
        config(['chat.rate_limits.public_upload_session' => 2]);

        $this->upload($this->pngUpload())->assertCreated();
        $this->upload($this->pngUpload())->assertCreated();
        $this->upload($this->pngUpload())->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
    }
}
