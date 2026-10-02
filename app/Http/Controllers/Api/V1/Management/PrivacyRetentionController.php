<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Privacy\Actions\PruneConversations;
use App\Domain\Settings\Actions\UpdateSetting;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `GET|PUT /privacy/retention`: how long closed conversations (with their messages and images) are kept: `chat.retention_days`, 0 = for
 * ever, otherwise at least `PruneConversations::MIN_DAYS`. The daily `chat:prune-conversations` applies it. Administrators only.
 */
class PrivacyRetentionController extends ManagementController
{
    public function show(): JsonResponse
    {
        return $this->data(['days' => max(0, settings()->int('chat.retention_days', 0)), 'minimumDays' => PruneConversations::MIN_DAYS]);
    }

    public function update(Request $request, UpdateSetting $update): JsonResponse
    {
        $input = $request->validate(['days' => ['required', 'integer', 'min:0', 'max:3650']]);
        $actor = $this->actor($request);

        if (! $actor instanceof User) {
            throw ApiProblemException::unauthorized('unauthenticated', __('Sign in to continue.'));
        }

        $update('chat.retention_days', (int) $input['days'], $actor);

        return $this->show();
    }
}
