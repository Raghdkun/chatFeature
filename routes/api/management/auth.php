<?php

use App\Http\Controllers\Api\V1\Management\StaffAuthController;
use App\Http\Controllers\Api\V1\Management\StaffSignInController;
use App\Http\Middleware\Auth\LimitRequestBodySize;
use App\Http\Middleware\Auth\NoStoreResponses;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;
use Laravel\Sanctum\Http\Middleware\EnsureFrontendRequestsAreStateful;

/*
|--------------------------------------------------------------------------
| Own credential and tokens (management API, /api/v1/auth)
|--------------------------------------------------------------------------
| For any signed-in staff member (dashboard cookie or mobile bearer), only ever about themselves: `auth/me` says who and which driver,
| `auth/tokens` lists the caller's own bearer tokens (one per signed-in device), `DELETE auth/tokens/{id}` revokes one of them (anyone
| else's is a 404) and `POST auth/logout` revokes the token the call was made with. Limiter `staff-api`.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', ChatThrottle::class.':staff-api'])->prefix('auth')->group(function () {
    Route::get('me', [StaffAuthController::class, 'me'])->name('api.auth.me');
    Route::get('tokens', [StaffAuthController::class, 'tokens'])->name('api.auth.tokens.index');
    Route::delete('tokens/{token}', [StaffAuthController::class, 'revoke'])->whereNumber('token')->name('api.auth.tokens.destroy');
    Route::post('logout', [StaffAuthController::class, 'logout'])->name('api.auth.logout');
});

/*
|--------------------------------------------------------------------------
| Sign in from a native client (GUEST routes: the only unauthenticated routes of the management API)
|--------------------------------------------------------------------------
| `POST auth/token` trades a password for a bearer token (`201`), or for a challenge when the account has a second factor (`202`);
| `POST auth/token/two-factor` answers the challenge. See docs/mobile-readiness.md and docs/security.md ("Native sign-in").
|
| Stateless by construction: Sanctum's stateful middleware is removed (no session is started and no cookie is set, whatever Origin the
| request claims), nothing is CORS-enabled, every answer is `Cache-Control: no-store`, and the body is capped before anything reads it.
| The password step is throttled by the `login` limiter, the SAME budget as the dashboard's login (per email and address, per address, per
| email), plus Fortify's failed-attempt lockout inside the action; the second-factor step by `staff-two-factor` plus per-account counters.
*/
Route::prefix('auth')
    ->middleware([NoStoreResponses::class, LimitRequestBodySize::class])
    ->withoutMiddleware([EnsureFrontendRequestsAreStateful::class])
    ->group(function () {
        Route::post('token', [StaffSignInController::class, 'store'])
            ->middleware(ChatThrottle::class.':login')
            ->name('api.auth.token.store');
        Route::post('token/two-factor', [StaffSignInController::class, 'twoFactor'])
            ->middleware(ChatThrottle::class.':staff-two-factor')
            ->name('api.auth.token.two-factor');
    });
