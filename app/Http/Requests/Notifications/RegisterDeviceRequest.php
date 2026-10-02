<?php

namespace App\Http\Requests\Notifications;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Body of `POST /me/devices` (the FCM stub): the platform and the registration token. */
class RegisterDeviceRequest extends FormRequest
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
            'platform' => ['required', 'string', Rule::in(['android', 'ios'])],
            'token' => ['required', 'string', 'min:20', 'max:4096'],
        ];
    }
}
