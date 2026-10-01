<?php

namespace App\Http\Requests\Chat;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Multipart body of `POST .../attachments`: one `file`. The size limit is checked here early (`chat.attachment_max_bytes`); the
 * type, dimensions and content are judged by `ImageSanitizer`, never by what the client claims.
 */
class UploadAttachmentRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $maxKilobytes = (int) ceil(max(1, settings()->int('chat.attachment_max_bytes', 5 * 1024 * 1024)) / 1024);

        return [
            'file' => ['required', 'file', 'max:'.$maxKilobytes],
        ];
    }
}
