<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\Agents\AgentListItemData;
use App\Data\Catalog\CategoryData;
use App\Support\ApiDocs\Doc;
use App\Support\ApiDocs\ExampleValues;

/** Categories (topics) and the staff directory. */
final class DirectoryEntries implements EntryList
{
    public static function docs(): array
    {
        $categories = ['category_ulids' => [ExampleValues::ulid('category')]];

        return [
            Doc::route('api.categories.index')
                ->in('Categories')
                ->title('List categories')
                ->about('Every staff member can read it: agents only see the active categories, administrators all of them. The list is complete (no paging).')
                ->list(CategoryData::class),

            Doc::route('api.categories.show')
                ->in('Categories')
                ->title('Show a category')
                ->item(CategoryData::class),

            Doc::route('api.categories.store')
                ->in('Categories')
                ->title('Create a category')
                ->about('The slug is generated from the name when omitted. A category used by a widget becomes a topic visitors can pick once it is enabled on it.')
                ->created(CategoryData::class)
                ->errors(['slug_taken', 'validation_failed' => 'A field is invalid (for example a malformed `color` or an unknown locale in `name_i18n`).']),

            Doc::route('api.categories.update')
                ->in('Categories')
                ->title('Update a category')
                ->about('Every field is optional.')
                ->item(CategoryData::class)
                ->errors(['slug_taken', 'validation_failed' => 'A field is invalid.']),

            Doc::route('api.categories.destroy')
                ->in('Categories')
                ->title('Delete a category')
                ->about('A soft delete (it frees the slug). Refused while a queued or active conversation uses the category.')
                ->noContent(204, 'Deleted.')
                ->errors(['category_in_use']),

            Doc::route('api.me.categories.show')
                ->in('Categories')
                ->title('Show the categories I serve')
                ->about('Agents only (`is_agent`): an administrator who does not take chats gets `403`.')
                ->data($categories, 200, '', ['category_ulids' => ['type' => 'string[]', 'description' => 'Ulids of the active categories the caller serves.']])
                ->errors(['forbidden' => 'The caller is not an agent.']),

            Doc::route('api.me.categories.update')
                ->in('Categories')
                ->title('Choose the categories I serve')
                ->about('Replaces the set with the given ACTIVE categories. Routing offers a chat only to agents who serve its category.')
                ->data($categories, 200, '', ['category_ulids' => ['type' => 'string[]', 'description' => 'The new complete set.']])
                ->errors(['forbidden' => 'The caller is not an agent.', 'validation_failed' => 'An entry is not an existing, active category.']),

            Doc::route('api.agents.index')
                ->in('Agents')
                ->title('List staff')
                ->about('Every staff account (administrators and agents), complete. `id` is the user id: this API is staff-only, so the integer id is used.')
                ->list(AgentListItemData::class),

            Doc::route('api.agents.store')
                ->in('Agents')
                ->title('Create an agent')
                ->about('Local auth mode only. The account is always active and takes chats. With the external auth portal accounts come from the portal: `409 managed_by_auth_portal`.')
                ->created(AgentListItemData::class)
                ->errors(['managed_by_auth_portal', 'validation_failed' => 'The e-mail is taken, the password is too weak, or a category does not exist.']),

            Doc::route('api.agents.update')
                ->in('Agents')
                ->title('Update an agent')
                ->about('`max_concurrent_chats` works in both auth modes. `is_active` and `is_agent` only in local mode: deactivating an account deletes its tokens, ends its sessions and returns its chats to the queue.')
                ->item(AgentListItemData::class)
                ->errors(['managed_by_auth_portal' => '`is_active` or `is_agent` in external auth mode.', 'cannot_deactivate_self', 'validation_failed' => 'A value is out of range.']),

            Doc::route('api.agents.categories.update')
                ->in('Agents')
                ->title('Assign categories to an agent')
                ->about('Replaces the set of categories the agent serves (both auth modes).')
                ->item(AgentListItemData::class)
                ->errors(['not_an_agent', 'validation_failed' => 'An entry is not an existing category.']),
        ];
    }
}
