<?php

use App\Support\RouteFiles;
use Illuminate\Support\Facades\Route;

// The app lives behind login: guests are sent to /login, signed-in staff to the dashboard.
Route::redirect('/', '/dashboard')->middleware('auth')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::inertia('dashboard', 'dashboard')->name('dashboard');
});

require __DIR__.'/settings.php';

RouteFiles::require(__DIR__.'/web');
