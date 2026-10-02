<?php

namespace App\Http\Requests\Auth;

use App\Auth\Tokens\DeviceName;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;

/**
 * Body of `POST /api/v1/auth/token`: the staff member's email and password and a label for the device. The email is canonicalised the way the
 * dashboard login does it (lower case: it is also the throttle key) and the device name cleaned ({@see DeviceName}) before it is validated,
 * so what is stored is what was checked.
 */
class StaffSignInRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $email = $this->input('email');
        $deviceName = $this->input('device_name');

        $this->merge([
            'email' => is_string($email) ? Str::lower(trim($email)) : $email,
            'device_name' => is_string($deviceName) ? DeviceName::clean($deviceName) : $deviceName,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email', 'max:254'],
            // Never trimmed or normalised (the framework leaves `password` alone); the cap bounds the hashing work.
            'password' => ['required', 'string', 'max:1024'],
            'device_name' => ['required', 'string', 'min:'.DeviceName::MIN_LENGTH, 'max:'.DeviceName::MAX_LENGTH],
        ];
    }
}
