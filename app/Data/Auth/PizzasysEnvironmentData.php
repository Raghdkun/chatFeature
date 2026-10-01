<?php

namespace App\Data\Auth;

use App\Models\AuthEnvironment;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * One auth-portal environment as the UI sees it. Secrets never travel: only `has_service_token` / `has_nats_token`.
 */
#[TypeScript]
class PizzasysEnvironmentData extends Data
{
    public function __construct(
        public EnvironmentKey $key,
        public string $label,
        public bool $configured,
        public ?string $base_url,
        public ?string $service_name,
        public bool $has_service_token,
        public ?string $nats_url,
        public bool $has_nats_token,
        public bool $verify_tls,
        public ?string $last_check_at,
        public ?PortalCheckStatus $last_check_status,
        public ?string $last_check_message,
    ) {}

    public static function fromModel(EnvironmentKey $key, ?AuthEnvironment $environment): self
    {
        if ($environment === null) {
            return self::unconfigured($key);
        }

        return new self(
            key: $key,
            label: $environment->label,
            configured: true,
            base_url: $environment->base_url,
            service_name: $environment->service_name,
            has_service_token: $environment->hasServiceToken(),
            nats_url: $environment->nats_url,
            has_nats_token: $environment->hasNatsToken(),
            verify_tls: $environment->verify_tls,
            last_check_at: $environment->last_check_at?->toIso8601String(),
            last_check_status: $environment->last_check_status !== null ? PortalCheckStatus::tryFrom($environment->last_check_status) : null,
            last_check_message: $environment->last_check_message,
        );
    }

    public static function unconfigured(EnvironmentKey $key): self
    {
        return new self($key, ucfirst($key->value), false, null, null, false, null, false, true, null, null, null);
    }
}
