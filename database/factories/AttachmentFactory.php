<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\SenderType;
use App\Models\Attachment;
use App\Models\Conversation;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * A stored 640x480 WebP that nobody has attached to a message yet. No file exists on the disk.
 *
 * @extends Factory<Attachment>
 */
class AttachmentFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $name = Str::lower((string) Str::ulid());

        return [
            'conversation_id' => Conversation::factory(),
            'message_id' => null,
            'uploader_type' => SenderType::Visitor,
            'uploader_user_id' => null,
            'disk' => 'local',
            'path' => "chat/attachments/{$name}.webp",
            'thumb_path' => "chat/attachments/{$name}_thumb.webp",
            'mime' => 'image/webp',
            'size' => 48_213,
            'width' => 640,
            'height' => 480,
            'sha256' => hash('sha256', $name),
            'original_name' => 'screenshot.png',
        ];
    }
}
