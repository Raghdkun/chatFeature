<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Catalog\CategoryData;
use App\Domain\Catalog\Actions\CreateCategory;
use App\Domain\Catalog\Actions\DeleteCategory;
use App\Domain\Catalog\Actions\UpdateCategory;
use App\Domain\Catalog\Support\CategoryQuery;
use App\Http\Requests\Catalog\StoreCategoryRequest;
use App\Http\Requests\Catalog\UpdateCategoryRequest;
use App\Models\Category;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Category CRUD. Listing is open to every staff member (agents pick from it); writes are admin-only (route middleware).
 */
class CategoryController extends ManagementController
{
    public function index(Request $request, CategoryQuery $categories): JsonResponse
    {
        // Agents only see what they can serve; admins also see inactive categories.
        $user = $this->actor($request);
        $onlyActive = $user === null || ! $user->is_admin;

        return $this->list($categories->all($onlyActive)->map(fn (Category $category): CategoryData => CategoryData::fromCategory($category)));
    }

    public function show(Category $category, CategoryQuery $categories): JsonResponse
    {
        return $this->data(CategoryData::fromCategory($categories->withCounts($category)));
    }

    public function store(StoreCategoryRequest $request, CreateCategory $action, CategoryQuery $categories): JsonResponse
    {
        $category = $action->handle($request->categoryAttributes(), $this->actor($request));

        return $this->data(CategoryData::fromCategory($categories->withCounts($category)), 201);
    }

    public function update(UpdateCategoryRequest $request, Category $category, UpdateCategory $action, CategoryQuery $categories): JsonResponse
    {
        $category = $action->handle($category, $request->categoryAttributes(), $this->actor($request));

        return $this->data(CategoryData::fromCategory($categories->withCounts($category)));
    }

    public function destroy(Request $request, Category $category, DeleteCategory $action): Response
    {
        $action->handle($category, $this->actor($request));

        return response()->noContent();
    }
}
