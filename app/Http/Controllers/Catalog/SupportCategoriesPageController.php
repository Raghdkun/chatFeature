<?php

namespace App\Http\Controllers\Catalog;

use App\Data\Catalog\CategoryData;
use App\Domain\Catalog\Support\CategoryQuery;
use App\Domain\Catalog\Support\UserCategories;
use App\Http\Controllers\Controller;
use App\Models\Category;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `settings/support-categories`: every staff member (agents included) picks which active categories they serve.
 */
class SupportCategoriesPageController extends Controller
{
    public function edit(Request $request, CategoryQuery $categories, UserCategories $selected): Response
    {
        $user = $request->user();
        abort_if($user === null, 401);

        return Inertia::render('settings/support-categories', [
            'categories' => $categories->all(onlyActive: true)->map(fn (Category $category): array => CategoryData::fromCategory($category)->toArray())->all(),
            'selected' => $selected->ulidsFor($user),
        ]);
    }
}
