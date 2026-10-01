<?php

namespace App\Http\Controllers\Settings;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Pizzasys\Actions\ActivateEnvironment;
use App\Auth\Pizzasys\Actions\BuildAuthSettingsData;
use App\Auth\Pizzasys\Actions\PortalPreflightFailed;
use App\Auth\Pizzasys\Actions\SaveAuthEnvironment;
use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Data\Auth\PortalCheckKey;
use App\Data\Auth\PortalCheckStatus;
use App\Domain\Audit\AuditLogger;
use App\Domain\Settings\SettingsRepository;
use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\ActivateAuthEnvironmentRequest;
use App\Http\Requests\Auth\UpdateAuthEnvironmentRequest;
use App\Http\Requests\Auth\UpdateAuthRolesRequest;
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

    public function updateEnvironment(UpdateAuthEnvironmentRequest $request, string $key, SaveAuthEnvironment $save): RedirectResponse|JsonResponse
    {
        $this->requirePortalMode();

        try {
            $save($key, $request->toInput(), $request->user(), 'dashboard');
        } catch (PortalPreflightFailed $failure) {
            return $this->preflightFailed($request, $failure);
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

    /**
     * Nothing was saved because the portal did not accept the settings of the active environment. Plain JSON callers get
     * the failing checks; form posts get field errors (`base_url`: not reachable, `service_token`: credential refused,
     * `connection`: the summary).
     */
    private function preflightFailed(Request $request, PortalPreflightFailed $failure): JsonResponse
    {
        $errors = ['connection' => [__('These settings were not saved because the portal did not accept them. Fix them and save again.')]];

        foreach ($failure->result->checks as $check) {
            $message = is_string($check->message) ? $check->message : null;

            if ($check->ok || $message === null) {
                continue;
            }

            $field = match ($check->key) {
                PortalCheckKey::Reachable => 'base_url',
                PortalCheckKey::ServiceCredential => 'service_token',
                default => null,
            };

            if ($field !== null) {
                $errors[$field][] = $message;
            }
        }

        if (! $request->expectsJson()) {
            throw ValidationException::withMessages($errors);
        }

        return response()->json(['message' => $errors['connection'][0], 'errors' => $errors, 'checks' => $failure->result->toArray()['checks']], 422);
    }
}
