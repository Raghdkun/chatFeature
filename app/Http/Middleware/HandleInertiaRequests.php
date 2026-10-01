<?php

namespace App\Http\Middleware;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthMode;
use App\Data\Auth\AuthCapabilitiesData;
use App\Data\Auth\AuthUserData;
use App\Data\Shared\FlashData;
use App\Data\Shared\SharedAuthData;
use App\Data\Shared\SharedPropsData;
use App\Data\Shared\TextDirection;
use App\Domain\Install\InstallState;
use App\Models\User;
use Illuminate\Http\Request;
use Inertia\Middleware;
use Spatie\LaravelData\Optional;

class HandleInertiaRequests extends Middleware
{
    /**
     * The root template that's loaded on the first page visit.
     *
     * @see https://inertiajs.com/server-side-setup#root-template
     *
     * @var string
     */
    protected $rootView = 'app';

    public function __construct(private readonly InstallState $install) {}

    /**
     * Determines the current asset version.
     *
     * @see https://inertiajs.com/asset-versioning
     */
    public function version(Request $request): ?string
    {
        return parent::version($request);
    }

    /**
     * Define the props that are shared by default (contract: docs/contracts/inertia-shared-props.md).
     *
     * Before the app is installed there is no database: the guest props are built from config only.
     *
     * @see https://inertiajs.com/shared-data
     *
     * @return array<string, mixed>
     */
    public function share(Request $request): array
    {
        $installed = $this->install->isInstalled();
        $user = $installed ? $request->user() : null;
        $locale = app()->getLocale();

        $shared = new SharedPropsData(
            name: $installed ? settings()->string('app.name', (string) config('app.name')) : (string) config('app.name'),
            auth: new SharedAuthData(
                user: $user instanceof User ? AuthUserData::fromUser($user) : null,
                mode: $installed ? $this->mode() : AuthMode::Fortify,
                capabilities: AuthCapabilitiesData::fromCapabilities(app(AuthDriver::class)->capabilities()),
            ),
            locale: $locale,
            direction: in_array(substr($locale, 0, 2), (array) config('chat.rtl_locales', []), true) ? TextDirection::Rtl : TextDirection::Ltr,
            installed: $installed,
            sidebarOpen: ! $request->hasCookie('sidebar_state') || $request->cookie('sidebar_state') === 'true',
            flash: $this->flash($request),
        );

        $props = $shared->toArray();
        // An empty flash must still serialise as a JSON object, not as `[]`.
        $props['flash'] = (object) $props['flash'];

        return [
            ...parent::share($request),
            ...$props,
        ];
    }

    private function mode(): AuthMode
    {
        return AuthMode::tryFrom(app(AuthModeManager::class)->getDefaultDriver()) ?? AuthMode::Fortify;
    }

    private function flash(Request $request): FlashData
    {
        $success = $request->hasSession() ? $request->session()->get('success') : null;
        $error = $request->hasSession() ? $request->session()->get('error') : null;

        return new FlashData(
            success: is_string($success) ? $success : new Optional,
            error: is_string($error) ? $error : new Optional,
        );
    }
}
