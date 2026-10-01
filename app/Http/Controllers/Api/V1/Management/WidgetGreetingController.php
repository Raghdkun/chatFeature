<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Widgets\GreetingData;
use App\Domain\Widgets\Actions\ReplaceGreetings;
use App\Http\Requests\Widgets\ReplaceGreetingsRequest;
use App\Models\Widget;
use App\Models\WidgetGreeting;
use Illuminate\Http\JsonResponse;

/** `PUT /widgets/{ulid}/greetings`: replaces the greeting pool. */
class WidgetGreetingController extends ManagementController
{
    public function update(ReplaceGreetingsRequest $request, Widget $widget, ReplaceGreetings $action): JsonResponse
    {
        $greetings = $action->handle($widget, $request->normalizedGreetings(), $this->actor($request));

        return $this->list($greetings->map(fn (WidgetGreeting $greeting): GreetingData => GreetingData::fromGreeting($greeting)));
    }
}
