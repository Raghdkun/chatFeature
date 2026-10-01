<?php

namespace App\Auth\Pizzasys\Actions;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\NatsRestartSignal;
use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PortalHealth;
use App\Auth\Pizzasys\SecretReentry;
use App\Auth\Pizzasys\VerifyCache;
use App\Domain\Audit\AuditLogger;
use App\Models\AuthEnvironment;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Persist one auth environment from Settings > Auth or `chat:auth:set-env`.
 *
 *  - A secret is never reused for a new destination: when the portal address, the service name or the NATS address
 *    changes (or certificate verification is switched off) the matching token has to be submitted again
 *    ({@see SecretReentry}); otherwise a ValidationException names the field.
 *  - Edits of the ACTIVE environment that change how the portal is called are tried against the portal first (with the
 *    submitted values, nothing saved yet); a failing test throws {@see PortalPreflightFailed}. A typo there would
 *    otherwise make every sign-in and every session fail at once.
 *  - The audit row flags address changes (`address_changed`) and never carries a secret.
 */
final class SaveAuthEnvironment
{
    public function __construct(
        private readonly AuthEnvironmentRepository $environments,
        private readonly TestPortalConnection $test,
        private readonly AuditLogger $audit,
        private readonly PortalHealth $health,
        private readonly PizzasysCircuitBreaker $breaker,
        private readonly VerifyCache $verifyCache,
        private readonly NatsRestartSignal $restart,
    ) {}

    /**
     * @param  'dashboard'|'cli'  $via
     * @param  bool  $preflight  false only for the break-glass command, which exists for when the portal cannot be reached.
     *
     * @throws ValidationException
     * @throws PortalPreflightFailed
     */
    public function __invoke(string $key, EnvironmentInput $input, ?User $actor, string $via = 'dashboard', bool $preflight = true): AuthEnvironment
    {
        try {
            return $this->save($key, $input, $actor, $via, $preflight);
        } catch (UniqueConstraintViolationException) {
            // Two requests created the same environment at once: the other one won, so this one is an update now.
            return $this->save($key, $input, $actor, $via, $preflight);
        }
    }

    private function save(string $key, EnvironmentInput $input, ?User $actor, string $via, bool $preflight): AuthEnvironment
    {
        $environment = $this->environments->find($key) ?? new AuthEnvironment(['key' => $key]);
        $creating = ! $environment->exists;

        if (! $creating && ($missing = SecretReentry::missingForEnvironment($environment, $input)) !== []) {
            throw ValidationException::withMessages($missing);
        }

        $before = $environment->only(['label', 'base_url', 'api_prefix', 'service_name', 'nats_url', 'verify_tls']);
        $natsUrl = $this->nullableString($input->natsUrl);
        $apiPrefix = $this->nullableString($input->apiPrefix);
        $changes = [];

        $environment->fill([
            'label' => $this->nullableString($input->label) ?? ($environment->label ?: ucfirst($key)),
            'base_url' => rtrim($input->baseUrl, '/'),
            'api_prefix' => $apiPrefix !== null ? '/'.trim($apiPrefix, '/') : ($environment->api_prefix ?: '/api/v1'),
            'service_name' => $input->serviceName,
            'nats_url' => $natsUrl,
            'verify_tls' => $input->verifyTls ?? ($creating ? true : $environment->verify_tls),
        ]);

        if ($input->hasServiceToken()) {
            $environment->service_token = $input->serviceToken;
            $changes['service_credential_changed'] = true;
        }

        if ($natsUrl === null) {
            // No NATS URL, no NATS token.
            if ($environment->hasNatsToken()) {
                $environment->nats_token = null;
                $changes['nats_credential_changed'] = true;
            }
        } elseif ($input->natsTokenGiven) {
            $environment->nats_token = $this->nullableString($input->natsToken);
            $changes['nats_credential_changed'] = true;
        }

        foreach ($before as $field => $old) {
            if ($environment->isDirty($field)) {
                $changes[$field] = ['old' => $old, 'new' => $environment->getAttribute($field)];
            }
        }

        $changed = $changes !== [] || $creating;

        if ($changed && $this->destinationChanged($changes)) {
            $changes['address_changed'] = true;
        }

        if ($preflight && $changed && $environment->key === $this->environments->activeKey() && $this->connectionChanged($changes, $creating)) {
            $this->preflight($environment);
        }

        if ($changed) {
            // The last test result described the old settings.
            $environment->fill(['last_check_at' => null, 'last_check_status' => null, 'last_check_message' => null]);
        }

        DB::transaction(function () use ($environment, $changes, $creating, $changed, $actor, $via): void {
            $environment->save();

            if ($changed) {
                $this->audit->record($creating ? 'auth.environment_created' : 'auth.environment_updated', $environment, $changes + ['via' => $via], $actor);
            }
        });

        if ($changed) {
            // New address or credentials: what was observed about the old ones no longer applies.
            $this->health->clearServiceRejected($environment->key);
            $this->breaker->reset($environment->key);
        }

        if ($changed && $environment->key === $this->environments->activeKey()) {
            $this->environments->syncNatsEnabled();
            $this->verifyCache->flushAll();
            $this->restart->request();
        }

        return $environment;
    }

    /**
     * Try the submitted settings (still unsaved on the model) against the portal.
     *
     * @throws PortalPreflightFailed
     * @throws ValidationException
     */
    private function preflight(AuthEnvironment $environment): void
    {
        $endpoint = $environment->endpoint();

        if ($endpoint === null) {
            throw ValidationException::withMessages([SecretReentry::SERVICE_TOKEN => __('Enter the service token.')]);
        }

        $result = ($this->test)($endpoint, $environment->nats_url, $environment->nats_token);

        if (! $result->ok) {
            throw new PortalPreflightFailed($result);
        }
    }

    /**
     * @param  array<string, mixed>  $changes
     */
    private function destinationChanged(array $changes): bool
    {
        return isset($changes['base_url']) || isset($changes['service_name']) || isset($changes['nats_url']);
    }

    /**
     * Does the change affect how the portal itself is called (as opposed to the NATS block, the label or the role mapping)?
     *
     * @param  array<string, mixed>  $changes
     */
    private function connectionChanged(array $changes, bool $creating): bool
    {
        if ($creating) {
            return true;
        }

        foreach (['base_url', 'api_prefix', 'service_name', 'verify_tls', 'service_credential_changed'] as $field) {
            if (isset($changes[$field])) {
                return true;
            }
        }

        return false;
    }

    private function nullableString(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
