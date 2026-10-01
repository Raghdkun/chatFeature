<?php

namespace App\Http\Requests\Auth;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Models\User;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Settings > Auth: save one environment. A token that is left out (or empty) keeps the stored one; `nats_token: null`
 * clears the NATS token. The service token is required only while the environment does not exist yet.
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

    /** Whether the client sent a `nats_token` key at all (null/empty then means "clear"). */
    public function wantsNatsTokenChange(): bool
    {
        return $this->has('nats_token');
    }
}
