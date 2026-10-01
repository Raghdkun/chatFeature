import { Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import {
    PizzasysRolesFields,
    type RolesErrorField,
} from '@/components/setup/pizzasys-roles-fields';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAuthFormSubmit } from '@/hooks/use-auth-form-submit';
import { useTrans } from '@/hooks/use-trans';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import {
    areRolesDirty,
    rolesPayload,
    rolesValuesFrom,
    validateRoles,
    type FieldIssues,
} from '@/lib/pizzasys-form';
import type { PizzasysRoles } from '@/types/pizzasys';

/**
 * How portal permissions become this app's roles (`PUT /settings/auth/roles`). Saving re-checks
 * everyone's access on their next request; nobody is signed out.
 */
export function RolesCard({ roles }: { roles: PizzasysRoles }) {
    const { t } = useTrans();
    const [values, setValues] = useState<PizzasysRoles>(() =>
        rolesValuesFrom(roles),
    );
    const [issues, setIssues] = useState<FieldIssues>({});
    const [focusTick, setFocusTick] = useState(0);
    const formRef = useRef<HTMLFormElement>(null);
    const { errors, processing, submit, clearError } = useAuthFormSubmit();
    const dirty = areRolesDirty(values, roles);

    useEffect(() => {
        if (focusTick > 0) {
            formRef.current
                ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [focusTick]);

    const errorFor = (field: RolesErrorField): string | undefined => {
        const issue = issues[field];

        return (
            errors[field] ??
            (issue ? t(`setup.pizzasys.error.${issue}`) : undefined)
        );
    };

    const change = (patch: Partial<PizzasysRoles>) => {
        setValues((current) => ({ ...current, ...patch }));
        clearError(...Object.keys(patch));
        setIssues((current) => {
            const next = { ...current };

            for (const field of Object.keys(patch)) {
                delete next[field];
            }

            return next;
        });
    };

    const save = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (processing || !dirty) {
            return;
        }

        const found = validateRoles(values);

        setIssues(found);

        if (Object.keys(found).length > 0) {
            setFocusTick((tick) => tick + 1);

            return;
        }

        submit('put', authSettingsRoutes.roles, rolesPayload(values), {
            onSuccess: () => toast.success(t('settings.auth.roles.saved')),
            onError: () => setFocusTick((tick) => tick + 1),
        });
    };

    return (
        <Card
            role="region"
            aria-labelledby="settings-auth-roles-title"
            data-testid="settings-auth-roles"
        >
            <CardHeader>
                <CardTitle
                    id="settings-auth-roles-title"
                    role="heading"
                    aria-level={2}
                >
                    {t('setup.pizzasys.roles.title')}
                </CardTitle>
                <CardDescription>
                    {t('setup.pizzasys.roles.description')}
                </CardDescription>
            </CardHeader>

            <form
                ref={formRef}
                onSubmit={save}
                noValidate
                data-testid="settings-auth-roles-form"
                className="grid gap-6"
            >
                <CardContent>
                    <PizzasysRolesFields
                        idPrefix="settings-auth-roles"
                        values={values}
                        layout="stacked"
                        disabled={processing}
                        onChange={change}
                        error={errorFor}
                    />
                </CardContent>
                <CardFooter className="flex-col items-stretch gap-3">
                    <div>
                        <Button
                            type="submit"
                            disabled={!dirty || processing}
                            data-testid="settings-auth-roles-save"
                        >
                            {processing ? <Spinner /> : <Save aria-hidden />}
                            {t('settings.auth.roles.save')}
                        </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {t('settings.auth.roles.note')}
                    </p>
                </CardFooter>
            </form>
        </Card>
    );
}
