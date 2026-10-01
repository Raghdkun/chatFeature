<?php

namespace App\Http\Controllers\Settings;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Pizzasys\Actions\ActivateEnvironment;
use App\Auth\Pizzasys\Actions\BuildAuthSettingsData;
use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Pizzasys\NatsRestartSignal;
use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PortalHealth;
use App\Auth\Pizzasys\VerifyCache;
use App\Data\Auth\PortalCheckStatus;
use App\Domain\Audit\AuditLogger;
use App\Domain\Settings\SettingsRepository;
use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\ActivateAuthEnvironmentRequest;
use App\Http\Requests\Auth\UpdateAuthEnvironmentRequest;
use App\Http\Requests\Auth\UpdateAuthRolesRequest;
use App\Models\AuthEnvironment;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Settings > Auth (admin only; docs/contracts/auth-pizzasys.md). In mode 1 the page only says that sign-in is managed
 * by this app and every write endpoint answers 404. Secrets are write-only: no response, prop or audit row carries one.
 */
class AuthSettingsController extends Controller
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuthEnvironmentRepository $environments,
        private readonly AuditLogger $audit,
    ) {}

    public function edit(BuildAuthSettingsData $build): Response
    {
        return Inertia::render('settings/auth', ['authSettings' => $build()]);
    }

    public function updateEnvironment(UpdateAuthEnvironmentRequest $request, string $key): RedirectResponse
    {
        $this->requirePortalMode();

        $environment = $this->environments->find($key) ?? new AuthEnvironment(['key' => $key]);
        $creating = ! $environment->exists;
        $before = $environment->only(['label', 'base_url', 'api_prefix', 'service_name', 'nats_url', 'verify_tls']);
        $serviceToken = $request->validated('service_token');
        $natsUrl = $request->validated('nats_url');
        $changes = [];

        $environment->fill([
            'label' => $this->nullableString($request->validated('label')) ?? ($environment->label ?: ucfirst($key)),
            'base_url' => rtrim((string) $request->validated('base_url'), '/'),
            'api_prefix' => $this->nullableString($request->validated('api_prefix')) !== null ? '/'.trim((string) $request->validated('api_prefix'), '/') : ($environment->api_prefix ?: '/api/v1'),
            'service_name' => (string) $request->validated('service_name'),
            'nats_url' => $this->nullableString($natsUrl),
            'verify_tls' => $request->has('verify_tls') ? $request->boolean('verify_tls') : ($creating ? true : $environment->verify_tls),
        ]);

        if (is_string($serviceToken) && $serviceToken !== '') {
            $environment->service_token = $serviceToken;
            $changes['service_credential_changed'] = true;
        }

        if ($this->nullableString($natsUrl) === null) {
            // No NATS URL, no NATS token.
            if ($environment->hasNatsToken()) {
                $environment->nats_token = null;
                $changes['nats_credential_changed'] = true;
            }
        } elseif ($request->wantsNatsTokenChange()) {
            $environment->nats_token = $this->nullableString($request->validated('nats_token'));
            $changes['nats_credential_changed'] = true;
        }

        foreach ($before as $field => $old) {
            if ($environment->isDirty($field)) {
                $changes[$field] = ['old' => $old, 'new' => $environment->getAttribute($field)];
            }
        }

        if ($changes !== [] || $creating) {
            // The last test result described the old settings.
            $environment->fill(['last_check_at' => null, 'last_check_status' => null, 'last_check_message' => null]);
        }

        DB::transaction(function () use ($environment, $changes, $creating, $request): void {
            $environment->save();

            if ($changes !== [] || $creating) {
                $this->audit->record($creating ? 'auth.environment_created' : 'auth.environment_updated', $environment, $changes, $request->user());
            }
        });

        if ($changes !== [] || $creating) {
            // New address or credentials: what was observed about the old ones no longer applies.
            app(PortalHealth::class)->clearServiceRejected($environment->key);
            app(PizzasysCircuitBreaker::class)->reset($environment->key);
        }

        if ($environment->key === $this->environments->activeKey() && ($changes !== [] || $creating)) {
            $this->environments->syncNatsEnabled();
            app(VerifyCache::class)->flushAll();
            app(NatsRestartSignal::class)->request();
        }

        return back()->with('success', __('Saved.'));
    }

    public function testEnvironment(string $key, TestPortalConnection $test): JsonResponse
    {
        $this->requirePortalMode();

        $environment = $this->environments->find($key);

        abort_if($environment === null, 404);

        $endpoint = $environment->endpoint();

        if ($endpoint === null) {
            throw ValidationException::withMessages(['service_token' => __('The stored service token cannot be read. Enter it again.')]);
        }

        $result = $test($endpoint, $environment->nats_url, $environment->nats_token);

        $environment->forceFill([
            'last_check_at' => now(),
            'last_check_status' => $result->ok ? PortalCheckStatus::Ok->value : PortalCheckStatus::Failed->value,
            'last_check_message' => $result->ok ? null : $result->failureSummary(),
        ])->save();

        return response()->json($result->toArray());
    }

    public function activateEnvironment(ActivateAuthEnvironmentRequest $request, ActivateEnvironment $activate, AuthDriver $driver): JsonResponse
    {
        $this->requirePortalMode();

        $actor = $request->user();
        abort_unless($actor instanceof User, 403);

        $result = $activate($actor, (string) $request->validated('env'), (string) $request->validated('email'), (string) $request->validated('password'));

        if (! $result->ok) {
            return response()->json(['ok' => false, 'message' => $result->message, 'code' => $result->code], 422);
        }

        // Every session of the other environment is revoked, the actor's included: end this browser session too.
        $driver->logout($request);

        return response()->json(['ok' => true, 'redirect' => route('login', absolute: false)]);
    }

    public function updateRoles(UpdateAuthRolesRequest $request, IdentityInvalidator $invalidator): RedirectResponse
    {
        $this->requirePortalMode();

        $mapping = $request->mapping();
        $before = ['admin_permission' => $this->settings->get('auth.pizzasys.admin_permission'), 'agent_permission' => $this->settings->get('auth.pizzasys.agent_permission'), 'super_roles' => $this->settings->get('auth.pizzasys.super_roles')];

        DB::transaction(function () use ($mapping, $before, $request): void {
            $actorId = $request->user()?->getAuthIdentifier();
            $actorId = is_int($actorId) ? $actorId : null;

            $this->settings->set('auth.pizzasys.admin_permission', $mapping->adminPermission, null, $actorId);
            $this->settings->set('auth.pizzasys.agent_permission', $mapping->agentPermission, null, $actorId);
            $this->settings->set('auth.pizzasys.super_roles', $mapping->superRoles, null, $actorId);

            $this->audit->record('auth.roles_updated', changes: [
                'old' => $before,
                'new' => ['admin_permission' => $mapping->adminPermission, 'agent_permission' => $mapping->agentPermission, 'super_roles' => $mapping->superRoles],
            ], actor: $request->user());
        });

        // Roles re-resolve from a fresh verification on each person's next request.
        $invalidator->flushAll();

        return back()->with('success', __('Saved.'));
    }

    private function requirePortalMode(): void
    {
        abort_unless($this->settings->string('auth.mode', 'fortify') === 'pizzasys', 404);
    }

    private function nullableString(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
