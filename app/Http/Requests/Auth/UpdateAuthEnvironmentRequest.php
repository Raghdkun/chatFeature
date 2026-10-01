<?php

namespace App\Http\Requests\Auth;

use App\Auth\Pizzasys\Actions\EnvironmentInput;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\SecretReentry;
use App\Models\User;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * Settings > Auth: save one environment. A token that is left out (or empty) keeps the stored one; `nats_token: null`
 * clears the NATS token. The service token is required only while the environment does not exist yet.
 *
 * A stored token is never reused for a new destination: changing the portal address, the service name or the NATS
 * address (or turning certificate verification off) fails with a 422 on `service_token` / `nats_token` until the
 * token is submitted again ({@see SecretReentry}).
 */
class UpdateAuthEnvironmentRequest extends FormRequest
{
    public function authorize(): bool
    {
        $user = $this->user();

        return $user instanceof User && $user->is_admin && $user->is_active;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        $exists = app(AuthEnvironmentRepository::class)->find((string) $this->route('key')) !== null;

        return [
            'label' => ['nullable', 'string', 'max:64'],
            'base_url' => ['required', 'string', new PortalUrl],
            'api_prefix' => ['nullable', 'string', 'regex:#^/[A-Za-z0-9/_-]{0,63}$#'],
            'service_name' => ['required', 'string', 'regex:/^[A-Za-z0-9._-]{1,64}$/'],
            'service_token' => [$exists ? 'nullable' : 'required', 'string', 'max:512'],
            'nats_url' => ['nullable', 'string', new NatsUrl],
            'nats_token' => ['nullable', 'string', 'max:512'],
            'verify_tls' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return list<Closure(Validator): void>
     */
    public function after(): array
    {
        return [function (Validator $validator): void {
            $stored = app(AuthEnvironmentRepository::class)->find((string) $this->route('key'));

            if ($validator->errors()->isNotEmpty() || $stored === null) {
                return;
            }

            foreach (SecretReentry::missingForEnvironment($stored, $this->toInput()) as $field => $message) {
                $validator->errors()->add($field, $message);
            }
        }];
    }

    /** What was submitted, as the action that persists it understands it. */
    public function toInput(): EnvironmentInput
    {
        return new EnvironmentInput(
            baseUrl: (string) $this->input('base_url'),
            serviceName: (string) $this->input('service_name'),
            label: $this->stringOrNull('label'),
            apiPrefix: $this->stringOrNull('api_prefix'),
            serviceToken: $this->stringOrNull('service_token'),
            natsUrl: $this->stringOrNull('nats_url'),
            natsToken: $this->stringOrNull('nats_token'),
            // Sent at all (null/empty then means "clear") versus left out ("keep the stored one").
            natsTokenGiven: $this->has('nats_token'),
            verifyTls: $this->has('verify_tls') ? $this->boolean('verify_tls') : null,
        );
    }

    private function stringOrNull(string $key): ?string
    {
        $value = $this->input($key);

        return is_string($value) ? $value : null;
    }
}
