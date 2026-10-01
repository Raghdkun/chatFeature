<?php

namespace App\Http\Requests\Auth;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Auth\Roles\RoleMapping;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * Settings > Auth: the role mapping. Refuses a mapping that would take administrator access away from the person saving
 * it, because a typo here would otherwise lock every administrator out of this very page.
 */
class UpdateAuthRolesRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Mode 1 has no portal to configure: 404 before the payload is even looked at.
        abort_unless(settings('auth.mode', 'fortify') === 'pizzasys', 404);

        $user = $this->user();

        return $user instanceof User && $user->is_admin && $user->is_active;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'admin_permission' => ['required', 'string', 'max:128'],
            'agent_permission' => ['required', 'string', 'max:128'],
            'super_roles' => ['present', 'array', 'max:20'],
            'super_roles.*' => ['required', 'string', 'max:64'],
        ];
    }

    /**
     * @return list<Closure(Validator): void>
     */
    public function after(): array
    {
        return [function (Validator $validator): void {
            $user = $this->user();
            $environment = app(AuthEnvironmentRepository::class)->active();

            if ($validator->errors()->isNotEmpty() || ! $user instanceof User || $environment === null) {
                return;
            }

            $identity = UserExternalIdentity::query()
                ->where('user_id', $user->getKey())
                ->where('auth_environment_id', $environment->getKey())
                ->first();

            if ($identity !== null && ! app(PizzasysRoleResolver::class)->decideFor($identity, $this->mapping())->isAdmin) {
                $validator->errors()->add('admin_permission', __('These names would remove your own administrator access. Keep a role or permission your own portal account has.'));
            }
        }];
    }

    public function mapping(): RoleMapping
    {
        /** @var list<string> $roles */
        $roles = array_values(array_unique(array_map('strval', (array) $this->input('super_roles', []))));

        return new RoleMapping((string) $this->input('admin_permission'), (string) $this->input('agent_permission'), $roles);
    }
}
