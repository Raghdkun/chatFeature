<?php

namespace App\Auth\Contracts;

use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\ApiAuthResult;
use App\Auth\Support\AuthCapabilities;
use App\Auth\Support\AuthResult;
use App\Auth\Support\HealthReport;
use App\Auth\Support\SessionContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Http\Request;

/**
 * A pluggable way of signing staff in (docs/contracts/auth-driver.md).
 * P1 ships FortifyDriver; P2 adds PizzasysDriver.
 */
interface AuthDriver
{
    /** 'fortify' | 'pizzasys' (matches settings('auth.mode')). */
    public function key(): string;

    /** What the UI may offer for this driver. */
    public function capabilities(): AuthCapabilities;

    /**
     * Web login: verifies the credentials against the `web` guard's user provider. Never throws for
     * bad credentials. It does NOT start the session: the caller (the Fortify pipeline) logs the
     * returned user in after any second factor, and may call this more than once per request.
     */
    public function attempt(Request $request): AuthResult;

    /**
     * Mobile/API login: validates credentials and returns OUR Sanctum token (never an upstream token).
     *
     * @param  array<string, mixed>  $credentials
     */
    public function attemptForApi(array $credentials, string $deviceName): ApiAuthResult;

    /** Called on authenticated requests (cheap, cached): is this session still valid? */
    public function validateSession(Authenticatable $user, SessionContext $context): SessionVerdict;

    public function logout(Request $request): void;

    public function health(): HealthReport;
}
