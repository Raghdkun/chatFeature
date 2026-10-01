<?php

use App\Http\Controllers\Api\V1\Public\BroadcastingAuthController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Visitor channel authorisation  (/api/v1/public/broadcasting/auth)
|--------------------------------------------------------------------------
| Bearer-only `widget` group (no session, no cookies, no CSRF). The limiter is keyed by a hash of the presented token and by the
| client network and runs before the token is looked up; `visitor` then resolves the session the channel is checked against.
*/
Route::post('broadcasting/auth', BroadcastingAuthController::class)
    ->middleware(['throttle:'.BroadcastingAuthController::LIMITER, 'visitor'])
    ->name('api.public.broadcasting.auth');
