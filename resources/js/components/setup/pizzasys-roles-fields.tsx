import { describedBy, Field } from '@/components/setup/field';
import { TagInput } from '@/components/setup/tag-input';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import { cn } from '@/lib/utils';
import type { PizzasysRoles } from '@/types/pizzasys';

export type RolesErrorField =
    | 'admin_permission'
    | 'agent_permission'
    | 'super_roles';

/**
 * How portal permissions map onto this app's two roles: the admin permission, the agent
 * permission and the "super roles" that always mean administrator. Shared by the wizard and
 * Settings > Auth. Ids and `data-testid`s are `<idPrefix>-admin-permission`, `-agent-permission`
 * and `-super-roles`.
 */
export function PizzasysRolesFields({
    idPrefix,
    values,
    onChange,
    error,
    disabled = false,
    layout = 'split',
}: {
    idPrefix: string;
    values: PizzasysRoles;
    onChange: (patch: Partial<PizzasysRoles>) => void;
    error: (field: RolesErrorField) => string | undefined;
    disabled?: boolean;
    layout?: 'split' | 'stacked';
}) {
    const { t } = useTrans();
    const id = (field: string) => `${idPrefix}-${field}`;

    return (
        <div className="grid gap-5">
            <div
                className={cn(
                    'grid gap-5',
                    layout === 'split' && 'sm:grid-cols-2',
                )}
            >
                <Field
                    id={id('admin-permission')}
                    label={t('setup.pizzasys.roles.admin_permission')}
                    hint={t('setup.pizzasys.roles.admin_permission_hint')}
                    error={error('admin_permission')}
                >
                    <Input
                        id={id('admin-permission')}
                        data-testid={id('admin-permission')}
                        dir="ltr"
                        value={values.admin_permission}
                        disabled={disabled}
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={LIMITS.permissionLength}
                        onChange={(event) =>
                            onChange({ admin_permission: event.target.value })
                        }
                        aria-invalid={
                            error('admin_permission') ? true : undefined
                        }
                        aria-describedby={describedBy(id('admin-permission'), {
                            hint: true,
                            error: error('admin_permission'),
                        })}
                    />
                </Field>

                <Field
                    id={id('agent-permission')}
                    label={t('setup.pizzasys.roles.agent_permission')}
                    hint={t('setup.pizzasys.roles.agent_permission_hint')}
                    error={error('agent_permission')}
                >
                    <Input
                        id={id('agent-permission')}
                        data-testid={id('agent-permission')}
                        dir="ltr"
                        value={values.agent_permission}
                        disabled={disabled}
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={LIMITS.permissionLength}
                        onChange={(event) =>
                            onChange({ agent_permission: event.target.value })
                        }
                        aria-invalid={
                            error('agent_permission') ? true : undefined
                        }
                        aria-describedby={describedBy(id('agent-permission'), {
                            hint: true,
                            error: error('agent_permission'),
                        })}
                    />
                </Field>
            </div>

            <Field
                id={id('super-roles')}
                label={t('setup.pizzasys.roles.super_roles')}
                hint={t('setup.pizzasys.roles.super_roles_hint')}
                error={error('super_roles')}
            >
                <TagInput
                    id={id('super-roles')}
                    testId={id('super-roles')}
                    value={values.super_roles}
                    disabled={disabled}
                    placeholder={t(
                        'setup.pizzasys.roles.super_roles_placeholder',
                    )}
                    invalid={Boolean(error('super_roles'))}
                    describedBy={describedBy(id('super-roles'), {
                        hint: true,
                        error: error('super_roles'),
                    })}
                    onChange={(next) => onChange({ super_roles: next })}
                />
            </Field>
        </div>
    );
}
