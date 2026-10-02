<?php

use App\Http\Controllers\Dashboard\SessionKeepAliveController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Session keep-alive (any staff)
|--------------------------------------------------------------------------
| The dashboard's API requests do not extend the session lifetime; this web request does (docs/security.md, "Sessions").
*/
Route::middleware(['auth', 'session.valid', 'chat.access'])->get('session/keepalive', SessionKeepAliveController::class)->name('session.keepalive');
