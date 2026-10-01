<?php

namespace App\Http\Controllers\Widgets;

use App\Data\Widgets\WidgetListItemData;
use App\Domain\Widgets\WidgetPresenter;
use App\Http\Controllers\Controller;
use App\Models\Widget;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia pages `widgets/index` and `widgets/builder` (admin only; props: docs/contracts/dashboard-pages-p3.md).
 */
class WidgetPageController extends Controller
{
    public function index(WidgetPresenter $presenter): Response
    {
        $widgets = Widget::query()->withCount(['domains', 'categories'])->orderBy('name')->orderBy('id')->get();

        return Inertia::render('widgets/index', [
            'widgets' => array_map(fn (WidgetListItemData $item): array => $item->toArray(), $presenter->listItems($widgets)),
        ]);
    }

    public function show(Widget $widget, WidgetPresenter $presenter): Response
    {
        $widget->load(['domains', 'greetings', 'categories']);

        return Inertia::render('widgets/builder', $presenter->builder($widget)->toArray());
    }
}
