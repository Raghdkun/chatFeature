<?php

namespace App\Http\Requests\WhatsApp;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `PUT /whatsapp/settings`: any subset of the settings. Only the shapes are checked here; ranges, the OpenWA address (SSRF guard)
 * and the hand-off text rule are the setting definitions' (`UpdateWhatsAppSettings`). `api_key` is write-only, printable ASCII without
 * spaces (it travels in a header).
 */
class UpdateSettingsRequest extends FormRequest
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
        return [
            'enabled' => ['sometimes', 'boolean'],
            'base_url' => ['sometimes', 'string', 'max:255'],
            'api_key' => ['sometimes', 'nullable', 'string', 'max:255', 'regex:/^[\x21-\x7e]+$/D'],
            'clear_api_key' => ['sometimes', 'boolean'],
            'handoff_ttl_minutes' => ['sometimes', 'integer'],
            'handoff_text' => ['sometimes', 'string', 'max:500'],
            'ignore_groups' => ['sometimes', 'boolean'],
            'reply_only_to_inbound' => ['sometimes', 'boolean'],
            'send_min_interval_ms' => ['sometimes', 'integer'],
            'daily_send_cap' => ['sometimes', 'integer'],
            'media_max_bytes' => ['sometimes', 'integer'],
        ];
    }

    public function messages(): array
    {
        return ['api_key.regex' => __('The API key may only contain visible characters, without spaces.')];
    }
}
