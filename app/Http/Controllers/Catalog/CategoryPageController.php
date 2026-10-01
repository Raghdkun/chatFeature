<?php

namespace App\Http\Controllers\Catalog;

use App\Data\Catalog\CategoryData;
use App\Domain\Catalog\Support\CategoryQuery;
use App\Http\Controllers\Controller;
use App\Models\Category;
use Inertia\Inertia;
use Inertia\Response;

/** Inertia page `categories/index` (admin only). */
class CategoryPageController extends Controller
{
    public function index(CategoryQuery $categories): Response
    {
        return Inertia::render('categories/index', [
            'categories' => $categories->all()->map(fn (Category $category): array => CategoryData::fromCategory($category)->toArray())->all(),
        ]);
    }
}
