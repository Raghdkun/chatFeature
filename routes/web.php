<?php

use App\Support\RouteFiles;
use Illuminate\Support\Facades\Route;

// The app lives behind login: guests are sent to /login, signed-in staff to the dashboard.
Route::redirect('/', '/dashboard')->middleware('auth')->name('home');

// Staff accounts are created by an administrator or an external auth portal, never by self-registration,
// so email verification is not part of access (it would lock out agents and portal users).
Route::middleware(['auth'])->group(function () {
    Route::inertia('dashboard', 'dashboard')->name('dashboard');
});

require __DIR__.'/settings.php';

RouteFiles::require(__DIR__.'/web');
