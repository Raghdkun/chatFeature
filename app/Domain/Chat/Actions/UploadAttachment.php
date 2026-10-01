<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Services\ImageSanitizer;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * An image upload to an active live chat (decision P4-D9). The file is judged and re-encoded by `ImageSanitizer` (content type
 * from `finfo`, size, dimensions, markup, EXIF stripped, 320 px thumbnail); only the re-encoded bytes are stored, on the private
 * disk under a random path, and the client's file name is kept sanitised for staff. The attachment belongs to this one
 * conversation and is referenced by the next message (`SendMessage`); uploads nobody references are pruned after a day.
 *
 * Visitors need the widget's `attachments` feature; at most `MAX_PENDING` uploads may wait unused per conversation, and one
 * conversation may hold `chat.attachment_max_total_bytes` of images in all (`422 attachment_quota_exceeded`, `details.file`).
 */
final class UploadAttachment
{
    public const MAX_PENDING = 10;

    public function __construct(
        private readonly ImageSanitizer $images,
        private readonly WidgetConfigValidator $configs,
    ) {}

    public function handle(Conversation $conversation, UploadedFile $file, SenderType $uploader, ?User $agent = null): Attachment
    {
        $conversation = Conversation::query()->with('widget')->findOrFail($conversation->id);

        if ($conversation->status !== ConversationStatus::Active || $conversation->type !== ConversationType::Live) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        if ($uploader === SenderType::Visitor && ! $this->configs->hydrate($conversation->widget->config)->features->attachments) {
            throw ApiProblemException::forbidden('feature_disabled', __('Images cannot be sent in this chat.'));
        }

        if (Attachment::query()->where('conversation_id', $conversation->id)->whereNull('message_id')->count() >= self::MAX_PENDING) {
            throw ValidationException::withMessages(['file' => [__('Too many images are waiting to be sent.')]]);
        }

        $path = $file->getRealPath();

        if (! $file->isValid() || $path === false) {
            throw ValidationException::withMessages(['file' => [__('The upload failed. Please try again.')]]);
        }

        $image = $this->images->sanitize(
            $path,
            max(1, settings()->int('chat.attachment_max_bytes', 5 * 1024 * 1024)),
            max(1, settings()->int('chat.attachment_max_dimension', 4096)),
        );

        $this->assertWithinQuota($conversation, strlen($image->bytes));

        $diskName = (string) config('chat.attachments_disk', 'local');
        $disk = Storage::disk($diskName);
        $base = 'chat/attachments/'.now()->format('Y/m').'/'.Str::lower(Str::random(40));
        $imagePath = $base.'.'.$image->extension;
        $thumbPath = $base.'_t.'.$image->extension;

        try {
            $disk->put($imagePath, $image->bytes, 'private');
            $disk->put($thumbPath, $image->thumbBytes, 'private');

            return Attachment::query()->create([
                'conversation_id' => $conversation->id,
                'uploader_type' => $uploader,
                'uploader_user_id' => $uploader === SenderType::Agent ? $agent?->id : null,
                'disk' => $diskName,
                'path' => $imagePath,
                'thumb_path' => $thumbPath,
                'mime' => $image->mime,
                'size' => strlen($image->bytes),
                'width' => $image->width,
                'height' => $image->height,
                'sha256' => hash('sha256', $image->bytes),
                'original_name' => $this->fileName($file),
            ]);
        } catch (Throwable $exception) {
            $disk->delete([$imagePath, $thumbPath]);

            throw $exception;
        }
    }

    /**
     * One conversation holds at most `chat.attachment_max_total_bytes` of images (visitor and agent uploads together): the per-file and
     * per-minute limits alone would still let one chat fill the disk. A soft cap: uploads racing each other can overshoot by one.
     */
    private function assertWithinQuota(Conversation $conversation, int $incomingBytes): void
    {
        $quota = (int) config('chat.attachment_max_total_bytes', 30 * 1024 * 1024);

        if ($quota < 1) {
            return;
        }

        $stored = (int) Attachment::query()->where('conversation_id', $conversation->id)->sum('size');

        if ($stored + $incomingBytes > $quota) {
            $message = __('This chat has reached the limit for images (:size in total).', ['size' => round($quota / 1024 / 1024, 1).' MB']);

            throw new ApiProblemException(422, 'attachment_quota_exceeded', $message, ['file' => [$message]]);
        }
    }

    /** What the client called the file, reduced to harmless characters (shown to staff only). */
    private function fileName(UploadedFile $file): ?string
    {
        $name = basename(str_replace('\\', '/', $file->getClientOriginalName()));
        $name = (string) preg_replace('/[^\p{L}\p{N}._ \-()]/u', '', $name);
        $name = trim(mb_substr($name, 0, 120));

        return $name === '' ? null : $name;
    }
}
