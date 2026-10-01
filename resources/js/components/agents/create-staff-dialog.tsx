import { useId, useState, type FormEvent } from 'react';
import { toggleUlid } from '@/components/agents/agent-model';
import { CategoryChip } from '@/components/categories/category-visuals';
import {
    Busy,
    FieldSet,
    Notice,
    TextField,
} from '@/components/widgets/form-bits';
import { describedBy, Field } from '@/components/setup/field';
import PasswordInput from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type {
    AgentListItemData,
    CategoryData,
    CreateStaffInput,
} from '@/types/widgets';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateStaffDialog({
    open,
    onOpenChange,
    categories,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    categories: CategoryData[];
    onCreated: (agent: AgentListItemData) => void;
}) {
    const { t } = useTrans();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-testid="agent-create-dialog"
                className="max-h-[92dvh] gap-0 overflow-y-auto p-0 sm:max-w-lg"
            >
                <DialogHeader className="border-b px-5 py-4 text-start sm:text-start">
                    <DialogTitle>{t('agents.create.title')}</DialogTitle>
                    <DialogDescription>
                        {t('agents.create.description')}
                    </DialogDescription>
                </DialogHeader>
                <StaffForm
                    categories={categories}
                    onCancel={() => onOpenChange(false)}
                    onDone={(agent) => {
                        onCreated(agent);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

type Errors = Record<string, string>;

function StaffForm({
    categories,
    onCancel,
    onDone,
}: {
    categories: CategoryData[];
    onCancel: () => void;
    onDone: (agent: AgentListItemData) => void;
}) {
    const { t } = useTrans();
    const uid = useId();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    const [errors, setErrors] = useState<Errors>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    function validate(): Errors {
        const found: Errors = {};

        if (name.trim() === '') {
            found.name = t('agents.create.errors.name');
        }

        if (!EMAIL.test(email.trim())) {
            found.email = t('agents.create.errors.email');
        }

        if (password.length < 8) {
            found.password = t('agents.create.errors.password');
        }

        return found;
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const found = validate();

        setErrors(found);
        setFormError(null);

        if (Object.keys(found).length > 0) {
            return;
        }

        const body: CreateStaffInput = {
            name: name.trim(),
            email: email.trim(),
            password,
            is_agent: true,
            category_ulids: selected,
        };

        setSubmitting(true);

        try {
            onDone(
                await api.post<AgentListItemData>(
                    widgetsRoutes.api.agents.index(),
                    body,
                ),
            );
        } catch (error) {
            if (isApiError(error) && error.isValidation) {
                setErrors(
                    Object.fromEntries(
                        Object.entries(error.details).map(
                            ([field, messages]) => [field, messages[0]],
                        ),
                    ),
                );
            } else {
                setFormError(describeApiError(error, t));
            }
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate>
            <div className="grid gap-5 px-5 py-5">
                {formError && (
                    <Notice tone="danger" data-testid="agent-create-error">
                        {formError}
                    </Notice>
                )}

                <TextField
                    id={`${uid}-name`}
                    label={t('agents.create.name')}
                    value={name}
                    onValueChange={setName}
                    error={errors.name}
                    autoComplete="name"
                    required
                />
                <TextField
                    id={`${uid}-email`}
                    label={t('agents.create.email')}
                    type="email"
                    value={email}
                    onValueChange={setEmail}
                    error={errors.email}
                    autoComplete="off"
                    dir="ltr"
                    inputMode="email"
                    required
                />
                <Field
                    id={`${uid}-password`}
                    label={t('agents.create.password')}
                    hint={t('agents.create.password_hint')}
                    error={errors.password}
                >
                    <PasswordInput
                        id={`${uid}-password`}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        aria-invalid={errors.password ? true : undefined}
                        aria-describedby={describedBy(`${uid}-password`, {
                            hint: true,
                            error: errors.password,
                        })}
                    />
                </Field>

                <FieldSet
                    legend={t('agents.create.role')}
                    hint={t('agents.create.role_hint')}
                >
                    <label className="flex items-center gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                        <input
                            type="radio"
                            name={`${uid}-role`}
                            checked
                            readOnly
                            className="size-4 accent-[var(--primary)]"
                        />
                        <span className="font-medium">
                            {t('agents.role.agent')}
                        </span>
                        <span className="text-muted-foreground">
                            {t('agents.create.role_agent_hint')}
                        </span>
                    </label>
                </FieldSet>

                <FieldSet
                    legend={t('agents.create.categories')}
                    hint={t('agents.create.categories_hint')}
                    error={errors.category_ulids}
                >
                    {categories.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t('agents.categories.no_catalog')}
                        </p>
                    ) : (
                        <ul className="grid gap-1 sm:grid-cols-2">
                            {categories.map((category) => {
                                const id = `${uid}-cat-${category.ulid}`;

                                return (
                                    <li key={category.ulid}>
                                        <div className="flex items-center gap-2.5 rounded-md border px-2.5 py-2">
                                            <Checkbox
                                                id={id}
                                                checked={selected.includes(
                                                    category.ulid,
                                                )}
                                                onCheckedChange={() =>
                                                    setSelected((current) =>
                                                        toggleUlid(
                                                            current,
                                                            category.ulid,
                                                        ),
                                                    )
                                                }
                                                data-testid={`agent-create-category-${category.ulid}`}
                                            />
                                            <Label
                                                htmlFor={id}
                                                className="min-w-0 flex-1 cursor-pointer font-normal"
                                            >
                                                <CategoryChip
                                                    name={category.name}
                                                    color={category.color}
                                                    className="border-0 bg-transparent px-0"
                                                />
                                            </Label>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </FieldSet>
            </div>

            <DialogFooter className="border-t bg-muted/30 px-5 py-3">
                <Button type="button" variant="outline" onClick={onCancel}>
                    {t('agents.create.cancel')}
                </Button>
                <Button
                    type="submit"
                    disabled={submitting}
                    data-testid="agent-create-submit"
                >
                    {submitting && <Busy />}
                    {t('agents.create.submit')}
                </Button>
            </DialogFooter>
        </form>
    );
}
