<?php

namespace App\Http\Requests\Chat;

use App\Models\Category;
use App\Models\User;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST /conversations/{ulid}/transfer`: either `agent_id` (a colleague) or `category` (a ulid or slug). */
class TransferConversationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'agent_id' => ['nullable', 'integer', 'min:1', 'exists:users,id', 'required_without:category', 'prohibits:category'],
            'category' => ['nullable', 'string', 'max:100', 'required_without:agent_id', 'prohibits:agent_id'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                if (filled($this->input('category')) && $this->category() === null) {
                    $validator->errors()->add('category', __('This topic does not exist.'));
                }
            },
        ];
    }

    public function agent(): ?User
    {
        $id = $this->validated('agent_id');

        return $id === null ? null : User::query()->find((int) $id);
    }

    public function category(): ?Category
    {
        $value = $this->input('category');

        return is_string($value) && $value !== ''
            ? Category::query()->where('ulid', $value)->orWhere('slug', $value)->first()
            : null;
    }
}
