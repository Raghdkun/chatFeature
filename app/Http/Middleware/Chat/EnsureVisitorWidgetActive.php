<?php

namespace App\Http\Middleware\Chat;

use App\Http\Exceptions\ApiProblemException;
use App\Models\VisitorSession;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * After `visitor`: a visitor token is bound to its widget, and a widget that was disabled or deleted since answers
 * `404 widget_not_found` on every chat call (the same answer the public widget endpoints give). Sets the `widget` request attribute.
 */
final class EnsureVisitorWidgetActive
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $session = $request->attributes->get('visitor_session');
        $widget = $session instanceof VisitorSession ? $session->widget : null;

        if ($widget === null || $widget->trashed() || ! $widget->is_enabled) {
            throw ApiProblemException::notFound('widget_not_found', __('This widget does not exist or is disabled.'));
        }

        $request->attributes->set('widget', $widget);

        return $next($request);
    }
}
