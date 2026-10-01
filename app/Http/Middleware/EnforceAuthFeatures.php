<?php

namespace App\Http\Middleware;

use App\Auth\Contracts\AuthDriver;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Fortify registers every auth route its features allow; the active AuthDriver decides which of
 * them may actually be used (e.g. registration only when `auth.allow_registration` is on, password
 * reset / 2FA / passkeys / profile edits not at all in pizzasys mode). Disabled features answer 404.
 */
final class EnforceAuthFeatures
{
    /**
     * Route names grouped by the AuthCapabilities flag that enables them.
     *
     * @var array<string, list<string>>
     */
    private const ROUTES = [
        'canRegister' => ['register', 'register.store'],
        'canResetPassword' => ['password.request', 'password.email', 'password.reset', 'password.update'],
        'canManage2fa' => [
            'two-factor.enable', 'two-factor.disable', 'two-factor.confirm', 'two-factor.qr-code',
            'two-factor.secret-key', 'two-factor.recovery-codes', 'two-factor.regenerate-recovery-codes',
            'passkey.store', 'passkey.registration-options', 'passkey.destroy',
        ],
        // Name, email and password belong to the auth portal in mode 2.
        'profileEditable' => ['profile.update', 'profile.destroy', 'user-password.update', 'security.edit'],
    ];

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $name = $request->route()?->getName();

        if ($name === null) {
            return $next($request);
        }

        foreach (self::ROUTES as $capability => $names) {
            if (in_array($name, $names, true) && ! $this->capable($capability)) {
                abort(404);
            }
        }

        return $next($request);
    }

    private function capable(string $capability): bool
    {
        $capabilities = app(AuthDriver::class)->capabilities();

        return match ($capability) {
            'canRegister' => $capabilities->canRegister,
            'canResetPassword' => $capabilities->canResetPassword,
            'canManage2fa' => $capabilities->canManage2fa,
            'profileEditable' => $capabilities->profileEditable,
            default => true,
        };
    }
}
