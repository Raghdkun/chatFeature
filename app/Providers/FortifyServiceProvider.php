<?php

namespace App\Providers;

use App\Actions\Fortify\CreateNewUser;
use App\Actions\Fortify\ResetUserPassword;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Support\AuthResult;
use App\Models\User;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Laravel\Fortify\Fortify;

class FortifyServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configureActions();
        $this->configureAuthentication();
        $this->configureViews();
        $this->configureRateLimiting();
    }

    /**
     * Configure Fortify actions.
     */
    private function configureActions(): void
    {
        Fortify::resetUserPasswordsUsing(ResetUserPassword::class);
        Fortify::createUsersUsing(CreateNewUser::class);
    }

    /**
     * Sign-in is delegated to the active AuthDriver (settings `auth.mode`).
     *
     * Fortify may call this twice per login (2FA redirect step, then the attempt itself), so the
     * driver's verdict is memoised on the request. The driver never logs the user in; the
     * Fortify pipeline does, after any second factor.
     */
    private function configureAuthentication(): void
    {
        Fortify::authenticateUsing(function (Request $request): ?User {
            $result = $request->attributes->get('auth.attempt');

            if (! $result instanceof AuthResult) {
                $driver = app(AuthDriver::class);

                // A portal session is bound to ONE browser session, so a "remember me" cookie could never resume it.
                if ($driver->key() === 'pizzasys') {
                    $request->merge(['remember' => false]);
                }

                $result = $driver->attempt($request);
                $request->attributes->set('auth.attempt', $result);
            }

            if ($result->outcome === AuthOutcome::Ok) {
                return $result->user;
            }

            // The login page shows its dedicated notices ("No chat access", "Auth Portal unreachable") for these reasons.
            if (in_array($result->outcome, [AuthOutcome::NoChatAccess, AuthOutcome::Unavailable], true)) {
                $request->session()->flash('reason', $result->outcome->value);
            }

            // Plain wrong credentials (Invalid, no message) fall through to Fortify's generic error
            // and lockout accounting; every other verdict carries a message the user should see.
            if ($result->message !== null) {
                throw ValidationException::withMessages([Fortify::username() => [$result->message]]);
            }

            if ($result->outcome === AuthOutcome::Unavailable) {
                throw ValidationException::withMessages([Fortify::username() => [__('Sign-in is temporarily unavailable. Please try again shortly.')]]);
            }

            return null;
        });
    }

    /**
     * Configure Fortify views.
     */
    private function configureViews(): void
    {
        Fortify::loginView(function (Request $request) {
            $capabilities = app(AuthDriver::class)->capabilities();

            return Inertia::render('auth/login', [
                'canResetPassword' => $capabilities->canResetPassword,
                'canRegister' => $capabilities->canRegister,
                'status' => $request->session()->get('status'),
                'reason' => $request->session()->get('reason'),
            ]);
        });

        Fortify::resetPasswordView(fn (Request $request) => Inertia::render('auth/reset-password', [
            'email' => $request->email,
            'token' => $request->route('token'),
            'passwordRules' => Password::defaults()->toPasswordRulesString(),
        ]));

        Fortify::requestPasswordResetLinkView(fn (Request $request) => Inertia::render('auth/forgot-password', [
            'status' => $request->session()->get('status'),
        ]));

        Fortify::verifyEmailView(fn (Request $request) => Inertia::render('auth/verify-email', [
            'status' => $request->session()->get('status'),
        ]));

        Fortify::registerView(fn () => Inertia::render('auth/register', [
            'passwordRules' => Password::defaults()->toPasswordRulesString(),
        ]));

        Fortify::twoFactorChallengeView(fn () => Inertia::render('auth/two-factor-challenge'));

        Fortify::confirmPasswordView(fn () => Inertia::render('auth/confirm-password'));
    }

    /**
     * Configure rate limiting.
     */
    private function configureRateLimiting(): void
    {
        RateLimiter::for('two-factor', function (Request $request) {
            return Limit::perMinute(5)->by($request->session()->get('login.id'));
        });

        RateLimiter::for('login', function (Request $request) {
            $throttleKey = Str::transliterate(Str::lower($request->input(Fortify::username())).'|'.$request->ip());

            return Limit::perMinute(5)->by($throttleKey);
        });

        RateLimiter::for('passkeys', function (Request $request) {
            return Limit::perMinute(10)->by(
                ($request->input('credential.id') ?: $request->session()->getId()).'|'.$request->ip(),
            );
        });
    }
}
