<?php

namespace App\Auth\Drivers;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\ApiAuthResult;
use App\Auth\Support\AuthCapabilities;
use App\Auth\Support\AuthResult;
use App\Auth\Support\HealthReport;
use App\Auth\Support\SessionContext;
use App\Domain\Settings\SettingsRepository;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Contracts\Auth\StatefulGuard;
use Illuminate\Contracts\Auth\UserProvider;
use Illuminate\Http\Request;
use Illuminate\Support\Timebox;
use Laravel\Fortify\Features;
use Laravel\Fortify\Fortify;

/**
 * Mode 1: the starter kit's local email + password login (2FA and passkeys stay Fortify's job).
 */
final class FortifyDriver implements AuthDriver
{
    public function __construct(
        private readonly AuthFactory $auth,
        private readonly SettingsRepository $settings,
    ) {}

    public function key(): string
    {
        return 'fortify';
    }

    public function capabilities(): AuthCapabilities
    {
        return new AuthCapabilities(
            canRegister: $this->settings->bool('auth.allow_registration'),
            canResetPassword: Features::enabled(Features::resetPasswords()),
            canManage2fa: Features::enabled(Features::twoFactorAuthentication()) || Features::enabled(Features::passkeys()),
            profileEditable: true,
            portalUrl: null,
        );
    }

    public function attempt(Request $request): AuthResult
    {
        $username = $request->input(Fortify::username());
        $password = $request->input('password');

        if (! is_string($username) || ! is_string($password)) {
            return AuthResult::invalid();
        }

        return $this->verify([Fortify::username() => $username, 'password' => $password]);
    }

    public function attemptForApi(array $credentials, string $deviceName): ApiAuthResult
    {
        $username = $credentials[Fortify::username()] ?? null;
        $password = $credentials['password'] ?? null;

        if (! is_string($username) || ! is_string($password)) {
            return ApiAuthResult::failed(AuthOutcome::Invalid);
        }

        $result = $this->verify([Fortify::username() => $username, 'password' => $password]);

        if (! $result->isOk() || $result->user === null) {
            return ApiAuthResult::failed($result->outcome, $result->message, $result->user);
        }

        return ApiAuthResult::ok($result->user, $result->user->createToken($deviceName)->plainTextToken);
    }

    public function validateSession(Authenticatable $user, SessionContext $context): SessionVerdict
    {
        if ($user instanceof User && ! $user->is_active) {
            return SessionVerdict::Revoked;
        }

        return SessionVerdict::Fresh;
    }

    public function logout(Request $request): void
    {
        $this->guard()->logout();

        if ($request->hasSession()) {
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }
    }

    public function health(): HealthReport
    {
        return HealthReport::ok();
    }

    /**
     * @param  array<string, string>  $credentials
     */
    private function verify(array $credentials): AuthResult
    {
        $provider = $this->provider();

        // Constant-ish time so a missing account cannot be told apart from a wrong password.
        $user = (new Timebox)->call(function () use ($provider, $credentials): ?Authenticatable {
            $user = $provider->retrieveByCredentials($credentials);

            if ($user === null || ! $provider->validateCredentials($user, $credentials)) {
                return null;
            }

            if (config('hashing.rehash_on_login', true)) {
                $provider->rehashPasswordIfRequired($user, $credentials);
            }

            return $user;
        }, 200000);

        if (! $user instanceof User) {
            return AuthResult::invalid();
        }

        if (! $user->is_active) {
            return AuthResult::invalid(__('This account has been deactivated. Contact an administrator.'));
        }

        if (! $user->hasChatAccess()) {
            return AuthResult::noChatAccess($user, __('This account has no access to the chat dashboard. Ask an administrator to grant it.'));
        }

        return AuthResult::ok($user);
    }

    private function guard(): StatefulGuard
    {
        /** @var StatefulGuard $guard */
        $guard = $this->auth->guard((string) config('fortify.guard', 'web'));

        return $guard;
    }

    private function provider(): UserProvider
    {
        return $this->guard()->getProvider();
    }
}
