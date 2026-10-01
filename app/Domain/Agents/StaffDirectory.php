<?php

namespace App\Domain\Agents;

use App\Data\Agents\AgentListItemData;
use App\Domain\Catalog\Support\UserCategories;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Read side of the staff list (admins and agents, active or not). Users with neither role flag are not staff
 * and never appear here.
 */
final class StaffDirectory
{
    public function __construct(private readonly UserCategories $categories) {}

    /**
     * @return Builder<User>
     */
    public function query(): Builder
    {
        return User::query()->where(fn (Builder $query) => $query->where('is_admin', true)->orWhere('is_agent', true));
    }

    public function find(int $id): User
    {
        return $this->query()->findOrFail($id);
    }

    /**
     * A staff member who takes chats (`is_agent`). Category assignment is only for them: P4 routing offers chats to
     * the users serving a category, and an admin who does not take chats must never be one of them.
     *
     * @throws ApiProblemException 409 `not_an_agent`
     */
    public function findAgent(int $id): User
    {
        $user = $this->find($id);

        if (! $user->is_agent) {
            throw ApiProblemException::conflict('not_an_agent', __('This account does not take chats, so it cannot serve categories. Turn on "takes chats" first.'));
        }

        return $user;
    }

    /**
     * @return array<int, AgentListItemData>
     */
    public function all(): array
    {
        $users = $this->query()->orderBy('name')->orderBy('id')->get();
        $categories = $this->categories->ulidsForUsers(array_values($users->map(fn (User $user): int => $user->id)->all()));

        return $users->map(fn (User $user): AgentListItemData => AgentListItemData::fromUser($user, $categories[$user->id] ?? []))->values()->all();
    }

    public function item(User $user): AgentListItemData
    {
        return AgentListItemData::fromUser($user, $this->categories->ulidsFor($user));
    }
}
