<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\Dashboard\ServingStatusData;
use App\Data\Dashboard\SetupStatusData;
use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `dashboard` (any staff): administrators get the setup checklist computed from the real configuration (what is missing
 * between an empty install and a visitor reaching an agent), every member of staff learns whether chats can reach them.
 */
class DashboardPageController extends Controller
{
    public function __invoke(Request $request): Response
    {
        /** @var User $user */
        $user = $request->user();

        return Inertia::render('dashboard', [
            'setup' => $user->is_admin ? $this->setup() : null,
            'serving' => ServingStatusData::for($user),
        ]);
    }

    private function setup(): SetupStatusData
    {
        $widgets = Widget::query();

        return new SetupStatusData(
            categories: Category::query()->active()->count(),
            widgets: (clone $widgets)->count(),
            widgetUlid: (clone $widgets)->orderBy('id')->value('ulid'),
            widgetsLive: (clone $widgets)->where('is_enabled', true)->count(),
            widgetsReachable: (clone $widgets)->where('is_enabled', true)->whereHas('domains')->count(),
            widgetCustomised: (clone $widgets)->where('config_version', '>', 1)->exists(),
            agentsServing: User::query()
                ->where('is_agent', true)
                ->where('is_active', true)
                ->whereHas('categories', fn ($query) => $query->where('categories.is_active', true))
                ->count(),
        );
    }
}
