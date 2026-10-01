<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Catalog\Actions\SyncUserCategories;
use App\Domain\Catalog\Support\UserCategories;
use App\Http\Requests\Catalog\SyncMyCategoriesRequest;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The categories the signed-in agent serves (`/me/categories`). Only agents have a set; admins who do not take chats get 403.
 */
class MeCategoryController extends ManagementController
{
    public function show(Request $request, UserCategories $categories): JsonResponse
    {
        $user = $this->requireAgent($request);

        return $this->data(['category_ulids' => $categories->ulidsFor($user)]);
    }

    public function update(SyncMyCategoriesRequest $request, SyncUserCategories $action, UserCategories $categories): JsonResponse
    {
        $user = $this->requireAgent($request);

        $action->handle($user, $request->categoryUlids(), $user);

        return $this->data(['category_ulids' => $categories->ulidsFor($user)]);
    }

    private function requireAgent(Request $request): User
    {
        $user = $this->actor($request);

        abort_unless($user !== null && $user->is_agent, 403, __('Only agents can choose categories to serve.'));

        return $user;
    }
}
