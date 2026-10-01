<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Agents\StaffDirectory;
use App\Domain\Catalog\Actions\SyncUserCategories;
use App\Http\Requests\Catalog\SyncCategoriesRequest;
use Illuminate\Http\JsonResponse;

/**
 * Admins assign the categories an agent serves (allowed in both auth modes). Only accounts that take chats
 * (`is_agent`) can serve categories: an admin without it answers `409 not_an_agent`.
 */
class AgentCategoryController extends ManagementController
{
    public function update(SyncCategoriesRequest $request, int $agent, StaffDirectory $staff, SyncUserCategories $action): JsonResponse
    {
        $target = $staff->findAgent($agent);

        $action->handle($target, $request->categoryUlids(), $this->actor($request), 'agent.categories_updated');

        return $this->data($staff->item($target));
    }
}
