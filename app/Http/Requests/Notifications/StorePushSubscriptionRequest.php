<?php

namespace App\Http\Requests\Notifications;

use App\Domain\Notifications\Support\PushEndpointGuard;
use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Body of `POST /me/push-subscriptions`: the browser's `PushSubscription.toJSON()` (`endpoint`, `expirationTime`, `keys.p256dh`,
 * `keys.auth`). The endpoint must be an https URL of a public host (the server posts to it); the keys must decode to what the push
 * encryption needs (a 65-byte uncompressed P-256 point and a 16-byte secret), so a bad one is refused here, not on the first push.
 */
class StorePushSubscriptionRequest extends FormRequest
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
            'endpoint' => ['required', 'string', 'max:'.PushEndpointGuard::MAX_LENGTH, function (string $attribute, mixed $value, Closure $fail): void {
                if (! is_string($value) || ! app(PushEndpointGuard::class)->allows($value)) {
                    $fail(__('This is not a push endpoint this server can send to.'));
                }
            }],
            'keys' => ['required', 'array'],
            'keys.p256dh' => ['required', 'string', 'max:128', $this->keyOfLength(65, "\x04")],
            'keys.auth' => ['required', 'string', 'max:64', $this->keyOfLength(16)],
            'expirationTime' => ['nullable', 'numeric', 'min:0'],
            'content_encoding' => ['sometimes', 'string', Rule::in(['aes128gcm', 'aesgcm'])],
        ];
    }

    /**
     * @return array{endpoint: string, p256dh: string, auth: string, content_encoding?: string, expiration_time?: int|float|null}
     */
    public function subscription(): array
    {
        /** @var array{endpoint: string, keys: array{p256dh: string, auth: string}, expirationTime?: int|float|null, content_encoding?: string} $data */
        $data = $this->validated();

        $subscription = [
            'endpoint' => $data['endpoint'],
            'p256dh' => $data['keys']['p256dh'],
            'auth' => $data['keys']['auth'],
            'expiration_time' => $data['expirationTime'] ?? null,
        ];

        if (isset($data['content_encoding'])) {
            $subscription['content_encoding'] = $data['content_encoding'];
        }

        return $subscription;
    }

    /** A URL-safe base64 value that decodes to exactly `$bytes` bytes (optionally starting with `$prefix`). */
    private function keyOfLength(int $bytes, string $prefix = ''): Closure
    {
        return function (string $attribute, mixed $value, Closure $fail) use ($bytes, $prefix): void {
            $decoded = is_string($value) && preg_match('/^[A-Za-z0-9_-]+={0,2}$/', $value) === 1
                ? base64_decode(strtr(rtrim($value, '='), '-_', '+/'), true)
                : false;

            if ($decoded === false || strlen($decoded) !== $bytes || ($prefix !== '' && ! str_starts_with($decoded, $prefix))) {
                $fail(__('The :attribute is not a valid push key.', ['attribute' => $attribute]));
            }
        };
    }
}
