<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\Chat\Services\ImageSanitizer;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Jobs\FetchInboundMedia;
use App\Models\WaMessage;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Inbound images (decision P6-D7): the bytes come from the webhook (`media.data`, base64) or, for a large image OpenWA did not inline,
 * from OpenWA's media endpoint (a queued job). They are judged by content and RE-ENCODED by the live chat's `ImageSanitizer` (EXIF,
 * comments and trailing data do not survive, size and dimension limits, animated GIFs refused) and only the new bytes are stored, on
 * the private disk under a random path, never under a name the sender chose. Anything that does not pass (not an image, too big, a
 * decompression bomb) leaves the message as a typed row without a file ("attachment not stored"): a bad file never fails a delivery.
 *
 * Documents, audio, video and stickers are not stored in P6: their rows carry the file name, type and size and nothing else.
 */
final class WaMediaStore
{
    public function __construct(private readonly ImageSanitizer $images) {}

    public static function disk(): string
    {
        return (string) config('whatsapp.media.disk', 'local');
    }

    /**
     * The decoded size of a base64 payload without decoding it, so a blob that is clearly over the limit is not decoded at all.
     */
    public function inlineBytes(string $base64): ?string
    {
        $limit = $this->maxBytes();
        $base64 = (string) preg_replace('#^data:[^,]*,#', '', trim($base64));

        if (strlen($base64) > intdiv($limit * 4, 3) + 8) {
            return null;
        }

        $bytes = base64_decode($base64, true);

        return $bytes === false || $bytes === '' ? null : $bytes;
    }

    /** Sanitise and store; false when the bytes are not a storable image (the message stays a typed row). */
    public function store(WaMessage $message, string $bytes, ?string $originalName = null): bool
    {
        $path = tempnam(sys_get_temp_dir(), 'wa-media-');

        if ($path === false) {
            return false;
        }

        try {
            file_put_contents($path, $bytes);

            $image = $this->images->sanitize($path, $this->maxBytes(), max(1, (int) config('whatsapp.media.max_dimension', 4096)));
        } catch (ValidationException) {
            return false;
        } finally {
            @unlink($path);
        }

        $key = 'whatsapp/media/'.now()->format('Y/m').'/'.Str::lower(Str::random(40)).'.'.$image->extension;
        $disk = Storage::disk(self::disk());

        try {
            $disk->put($key, $image->bytes, 'private');

            $stored = WaMessage::query()->whereKey($message->id)->whereNull('media_path')->update([
                'media_path' => $key,
                'media_mime' => $image->mime,
                'media_size' => strlen($image->bytes),
                'media_filename' => $this->fileName($originalName, $image->extension),
                'updated_at' => now(),
            ]);
        } catch (Throwable $exception) {
            $disk->delete($key);

            throw $exception;
        }

        if ($stored !== 1) {
            $disk->delete($key);

            return false;
        }

        return true;
    }

    /** Ask for OpenWA's copy of an image that was too large to inline (a queued job; the page learns of it through `wa.message.updated`). */
    public function queueFetch(WaMessage $message): void
    {
        FetchInboundMedia::dispatch($message->id);
    }

    /** Tell the open inbox that the message has a file now (the generic "message changed" signal: status unchanged). */
    public function announce(WaMessage $message): void
    {
        $message->refresh();
        WaMessageStatusChanged::dispatch($message, $message->status);
    }

    private function maxBytes(): int
    {
        return max(1, settings()->int('whatsapp.media_max_bytes', 5 * 1024 * 1024));
    }

    /** What the sender called the file, reduced to harmless characters (shown to administrators only); `image.<ext>` when none. */
    private function fileName(?string $name, string $extension): string
    {
        $name = $name === null ? '' : basename(str_replace('\\', '/', $name));
        $name = trim(mb_substr((string) preg_replace('/[^\p{L}\p{N}._ \-()]/u', '', $name), 0, 120));

        return $name === '' ? 'image.'.$extension : $name;
    }
}
