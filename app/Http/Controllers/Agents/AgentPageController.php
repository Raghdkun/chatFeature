<?php

namespace App\Http\Controllers\Agents;

use App\Data\Agents\AgentListItemData;
use App\Data\Catalog\CategoryData;
use App\Domain\Agents\AuthModeGuard;
use App\Domain\Agents\StaffDirectory;
use App\Domain\Catalog\Support\CategoryQuery;
use App\Http\Controllers\Controller;
use App\Models\Category;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `agents/index` (admin only). `canManageStaff` is true in mode 1 only: in mode 2 accounts and
 * roles come from the pizzasys portal.
 */
class AgentPageController extends Controller
{
    public function index(StaffDirectory $staff, CategoryQuery $categories, AuthModeGuard $mode): Response
    {
        return Inertia::render('agents/index', [
            'agents' => array_map(fn (AgentListItemData $agent): array => $agent->toArray(), $staff->all()),
            'categories' => $categories->all()->map(fn (Category $category): array => CategoryData::fromCategory($category)->toArray())->all(),
            'authMode' => $mode->mode()->value,
            'canManageStaff' => $mode->canManageStaff(),
        ]);
    }
}
