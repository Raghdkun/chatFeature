<?php

namespace App\Http\Requests\Setup;

use App\Auth\Enums\AuthMode;
use App\Data\Auth\EnvironmentKey;
use App\Domain\Install\InstallState;
use App\Domain\Install\Support\PizzasysAnswers;
use App\Rules\NatsUrl;
use App\Rules\PortalUrl;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * Mode 2, wizard screen "pizzasys": the portal environments, which one is active and the role mapping.
 * The service/NATS tokens are optional on a re-post (the stored ones are kept) but required the first time.
 */
class SavePizzasysRequest extends FormRequest
{
    public function authorize(): bool
    {
        return app(InstallState::class)->mode() === AuthMode::Pizzasys->value;
    }

    protected function prepareForValidation(): void
    {
        $this->merge([
            'admin_permission' => $this->input('admin_permission', 'chat.admin'),
            'agent_permission' => $this->input('agent_permission', 'chat.agent'),
            'super_roles' => $this->input('super_roles', ['super-admin']),
            'active_env' => $this->input('active_env', 'production'),
        ]);
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        $rules = [
            'active_env' => ['required', Rule::enum(EnvironmentKey::class)],
            'admin_permission' => ['required', 'string', 'max:128'],
            'agent_permission' => ['required', 'string', 'max:128'],
            'super_roles' => ['present', 'array', 'max:20'],
            'super_roles.*' => ['required', 'string', 'max:64'],
            'environments' => ['required', 'array'],
            'environments.production' => ['required', 'array'],
        ];

        foreach ($this->environmentKeys() as $key) {
            $rules += $this->environmentRules($key);
        }

        return $rules;
    }

    /**
     * @return array<string, string>
     */
    public function attributes(): array
    {
        return [
            'environments.production.base_url' => __('production address'),
            'environments.production.service_name' => __('production service name'),
            'environments.production.service_token' => __('production service token'),
            'environments.testing.base_url' => __('testing address'),
            'environments.testing.service_name' => __('testing service name'),
            'environments.testing.service_token' => __('testing service token'),
        ];
    }

    /**
     * @return list<Closure(Validator): void>
     */
    public function after(): array
    {
        return [function (Validator $validator): void {
            if ($this->input('active_env') === 'testing' && ! $this->hasTesting()) {
                $validator->errors()->add('active_env', __('Configure the testing environment before making it the active one.'));
            }
        }];
    }

    /**
     * What to store: normalised environments keyed by environment key (testing absent when not configured).
     *
     * @return array<string, array{base_url: string, api_prefix: string, service_name: string, service_token: string|null, nats_url: string|null, nats_token: string|null, verify_tls: bool}>
     */
    public function environmentAnswers(): array
    {
        $answers = [];

        foreach ($this->environmentKeys() as $key) {
            $input = (array) $this->input("environments.{$key}", []);

            $answers[$key] = [
                'base_url' => rtrim((string) ($input['base_url'] ?? ''), '/'),
                'api_prefix' => $this->normalisePrefix($input['api_prefix'] ?? null),
                'service_name' => (string) ($input['service_name'] ?? ''),
                'service_token' => isset($input['service_token']) && is_string($input['service_token']) && $input['service_token'] !== '' ? $input['service_token'] : null,
                'nats_url' => isset($input['nats_url']) && is_string($input['nats_url']) && $input['nats_url'] !== '' ? $input['nats_url'] : null,
                'nats_token' => isset($input['nats_token']) && is_string($input['nats_token']) && $input['nats_token'] !== '' ? $input['nats_token'] : null,
                'verify_tls' => ! array_key_exists('verify_tls', $input) || filter_var($input['verify_tls'], FILTER_VALIDATE_BOOLEAN),
            ];
        }

        return $answers;
    }

    /**
     * @return list<string>
     */
    private function environmentKeys(): array
    {
        return $this->hasTesting() ? ['production', 'testing'] : ['production'];
    }

    /** The testing environment is optional: it counts as configured as soon as any of its main fields is filled. */
    private function hasTesting(): bool
    {
        return $this->filled('environments.testing.base_url')
            || $this->filled('environments.testing.service_name')
            || $this->filled('environments.testing.service_token');
    }

    /**
     * @return array<string, array<mixed>>
     */
    private function environmentRules(string $key): array
    {
        $stored = PizzasysAnswers::from(app(InstallState::class)->read()['auth_environments'])->environment($key);
        $token = ['string', 'max:512'];

        return [
            "environments.{$key}.base_url" => ['required', 'string', new PortalUrl],
            "environments.{$key}.api_prefix" => ['nullable', 'string', 'regex:#^/[A-Za-z0-9/_-]{0,63}$#'],
            "environments.{$key}.service_name" => ['required', 'string', 'regex:/^[A-Za-z0-9._-]{1,64}$/'],
            "environments.{$key}.service_token" => $stored !== null && $stored['service_token'] !== null ? ['nullable', ...$token] : ['required', ...$token],
            "environments.{$key}.nats_url" => ['nullable', 'string', new NatsUrl],
            "environments.{$key}.nats_token" => ['nullable', ...$token],
            "environments.{$key}.verify_tls" => ['sometimes', 'boolean'],
        ];
    }

    private function normalisePrefix(mixed $prefix): string
    {
        return is_string($prefix) && $prefix !== '' ? '/'.trim($prefix, '/') : '/api/v1';
    }
}
