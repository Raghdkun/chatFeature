<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Agents\Actions\CreateLocalAgent;
use App\Domain\Agents\Actions\UpdateAgent;
use App\Domain\Agents\StaffDirectory;
use App\Http\Requests\Agents\StoreAgentRequest;
use App\Http\Requests\Agents\UpdateAgentRequest;
use Illuminate\Http\JsonResponse;

/**
 * Staff list and edits (admin only). Account creation and the `is_active` / `is_agent` flags only exist in mode 1;
 * in mode 2 they answer `409 managed_by_auth_portal` (roles come from pizzasys).
 */
class AgentController extends ManagementController
{
    public function index(StaffDirectory $staff): JsonResponse
    {
        return $this->list($staff->all());
    }

    public function store(StoreAgentRequest $request, CreateLocalAgent $action, StaffDirectory $staff): JsonResponse
    {
        /** @var array{name: string, email: string, password: string} $attributes */
        $attributes = $request->safe()->only(['name', 'email', 'password']);

        $user = $action->handle($attributes, $request->categoryUlids(), $this->actor($request));

        return $this->data($staff->item($user), 201);
    }

    public function update(UpdateAgentRequest $request, int $agent, UpdateAgent $action, StaffDirectory $staff): JsonResponse
    {
        $target = $staff->find($agent);
        $actor = $this->actor($request);
        abort_if($actor === null, 401);

        /** @var array{max_concurrent_chats?: int, is_active?: bool, is_agent?: bool} $attributes */
        $attributes = $request->validated();

        return $this->data($staff->item($action->handle($target, $attributes, $actor)));
    }
}
