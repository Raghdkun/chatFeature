import { Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import {
    CATEGORY_COLORS,
    CATEGORY_ICON_KEYS,
    categoryIcon,
} from '@/components/categories/category-visuals';
import {
    categoryRequestBody,
    categoryToForm,
    emptyCategoryForm,
    mapCategoryErrors,
    DESCRIPTION_MAX,
    newLocaleRow,
    NAME_MAX,
    SLUG_MAX,
    slugify,
    validateCategoryForm,
    type CategoryFormErrors,
    type CategoryFormValues,
    type LocaleRow,
} from '@/components/categories/category-form';
import {
    Busy,
    ColorField,
    FieldSet,
    Notice,
    SwitchRow,
    TextField,
} from '@/components/widgets/form-bits';
import { describedBy, Field } from '@/components/setup/field';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { LIMITS, LOCALE_CODE_LENGTH } from '@/lib/limits';
import { widgetsRoutes } from '@/lib/widgets-routes';
import { LOCALE_SUGGESTIONS } from '@/lib/widget-config';
import { cn } from '@/lib/utils';
import type { CategoryData } from '@/types/widgets';

function omit(errors: CategoryFormErrors, key: string): CategoryFormErrors {
    const next = { ...errors };

    delete next[key];

    return next;
}

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Present = edit, absent = create. */
    category?: CategoryData;
    nextSortOrder: number;
    onSaved: (category: CategoryData) => void;
};

export function CategoryDialog({ open, onOpenChange, ...rest }: Props) {
    const { t } = useTrans();
    const editing = rest.category !== undefined;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-testid="category-dialog"
                className="max-h-[92dvh] gap-0 overflow-y-auto p-0 sm:max-w-xl"
            >
                <DialogHeader className="border-b px-5 py-4 text-start sm:text-start">
                    <DialogTitle>
                        {editing
                            ? t('categories.dialog.edit_title')
                            : t('categories.dialog.create_title')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('categories.dialog.description')}
                    </DialogDescription>
                </DialogHeader>
                <CategoryForm
                    {...rest}
                    onCancel={() => onOpenChange(false)}
                    onDone={(saved) => {
                        rest.onSaved(saved);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

function CategoryForm({
    category,
    nextSortOrder,
    onCancel,
    onDone,
}: Pick<Props, 'category' | 'nextSortOrder'> & {
    onCancel: () => void;
    onDone: (category: CategoryData) => void;
}) {
    const { t } = useTrans();
    const uid = useId();
    const [values, setValues] = useState<CategoryFormValues>(() =>
        category ? categoryToForm(category) : emptyCategoryForm(),
    );
    const [errors, setErrors] = useState<CategoryFormErrors>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const set = (patch: Partial<CategoryFormValues>) =>
        setValues((current) => ({ ...current, ...patch }));

    function setName(name: string) {
        set({
            name,
            // Follow the name until the admin takes over the slug.
            ...(values.slugTouched ? {} : { slug: slugify(name) }),
        });
        setErrors((current) => omit(current, 'name'));
    }

    function updateRow(id: string, patch: Partial<LocaleRow>) {
        set({
            names: values.names.map((row) =>
                row.id === id ? { ...row, ...patch } : row,
            ),
        });
        setErrors((current) => omit(current, `names.${id}`));
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const clientErrors = validateCategoryForm(values, t);

        setErrors(clientErrors);
        setFormError(null);

        if (Object.keys(clientErrors).length > 0) {
            return;
        }

        setSubmitting(true);

        try {
            const saved = category
                ? await api.patch<CategoryData>(
                      widgetsRoutes.api.categories.show(category.ulid),
                      categoryRequestBody(values),
                  )
                : await api.post<CategoryData>(
                      widgetsRoutes.api.categories.index(),
                      categoryRequestBody(values, { sortOrder: nextSortOrder }),
                  );

            onDone(saved);
        } catch (error) {
            if (isApiError(error) && error.isValidation) {
                setErrors(mapCategoryErrors(error.details, values));
            } else {
                setFormError(describeApiError(error, t));
            }
        } finally {
            setSubmitting(false);
        }
    }

    const slugPlaceholder =
        slugify(values.name) || t('categories.dialog.slug_placeholder');

    return (
        <form onSubmit={submit} noValidate className="grid gap-0">
            <div className="grid gap-5 px-5 py-5">
                {formError && (
                    <Notice tone="danger" data-testid="category-form-error">
                        {formError}
                    </Notice>
                )}

                <TextField
                    id={`${uid}-name`}
                    label={t('categories.dialog.name')}
                    value={values.name}
                    onValueChange={setName}
                    maxLength={NAME_MAX}
                    error={errors.name}
                    required
                    autoComplete="off"
                />

                <TextField
                    id={`${uid}-slug`}
                    label={t('categories.dialog.slug')}
                    value={values.slug}
                    onValueChange={(slug) => {
                        set({ slug, slugTouched: true });
                        setErrors((current) => omit(current, 'slug'));
                    }}
                    placeholder={slugPlaceholder}
                    maxLength={SLUG_MAX}
                    hint={t('categories.dialog.slug_hint')}
                    error={errors.slug}
                    dir="ltr"
                    spellCheck={false}
                    inputClassName="font-mono text-sm"
                />

                <Field
                    id={`${uid}-description`}
                    label={t('categories.dialog.description_label')}
                    hint={t('categories.dialog.description_hint')}
                    error={errors.description}
                >
                    <Textarea
                        id={`${uid}-description`}
                        value={values.description}
                        onChange={(event) =>
                            set({ description: event.target.value })
                        }
                        rows={2}
                        maxLength={DESCRIPTION_MAX}
                        aria-invalid={errors.description ? true : undefined}
                        aria-describedby={describedBy(`${uid}-description`, {
                            hint: true,
                            error: errors.description,
                        })}
                    />
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                    <FieldSet
                        legend={t('categories.dialog.color')}
                        error={errors.color}
                    >
                        <div className="flex flex-wrap gap-2 p-1">
                            {CATEGORY_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    aria-pressed={values.color === color}
                                    aria-label={color}
                                    title={color}
                                    onClick={() => set({ color })}
                                    className={cn(
                                        'size-6 rounded-full border-2 border-transparent ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                                        values.color === color &&
                                            'ring-2 ring-foreground/70',
                                    )}
                                    style={{ backgroundColor: color }}
                                />
                            ))}
                        </div>
                        <ColorField
                            id={`${uid}-color`}
                            label={t('categories.dialog.color_custom')}
                            value={values.color ?? '#475569'}
                            onValueChange={(color) => set({ color })}
                        />
                    </FieldSet>

                    <FieldSet legend={t('categories.dialog.icon')}>
                        <div className="grid grid-cols-5 gap-1.5">
                            {CATEGORY_ICON_KEYS.map((key) => {
                                const Icon = categoryIcon(key);

                                return (
                                    <label
                                        key={key}
                                        title={t(`categories.icon.${key}`)}
                                        className={cn(
                                            'flex size-9 cursor-pointer items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent',
                                            'has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-accent-foreground',
                                            'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                                        )}
                                    >
                                        <input
                                            type="radio"
                                            name={`${uid}-icon`}
                                            value={key}
                                            checked={values.icon === key}
                                            onChange={() => set({ icon: key })}
                                            className="sr-only"
                                        />
                                        <Icon className="size-4" aria-hidden />
                                        <span className="sr-only">
                                            {t(`categories.icon.${key}`)}
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    </FieldSet>
                </div>

                <FieldSet
                    legend={t('categories.dialog.translations')}
                    hint={t('categories.dialog.translations_hint')}
                >
                    <datalist id={`${uid}-locales`}>
                        {LOCALE_SUGGESTIONS.map((code) => (
                            <option key={code} value={code} />
                        ))}
                    </datalist>
                    <ul className="grid gap-2">
                        {values.names.map((row, index) => (
                            <li key={row.id} className="grid gap-1">
                                <div className="flex items-center gap-2">
                                    <Input
                                        aria-label={t(
                                            'categories.dialog.locale_code',
                                            {
                                                n: index + 1,
                                            },
                                        )}
                                        value={row.locale}
                                        list={`${uid}-locales`}
                                        onChange={(event) =>
                                            updateRow(row.id, {
                                                locale: event.target.value.trim(),
                                            })
                                        }
                                        placeholder="ar"
                                        maxLength={LOCALE_CODE_LENGTH}
                                        dir="ltr"
                                        spellCheck={false}
                                        className="max-w-24 font-mono text-sm"
                                    />
                                    <Input
                                        aria-label={t(
                                            'categories.dialog.locale_name',
                                            {
                                                n: index + 1,
                                            },
                                        )}
                                        value={row.name}
                                        onChange={(event) =>
                                            updateRow(row.id, {
                                                name: event.target.value,
                                            })
                                        }
                                        placeholder={t(
                                            'categories.dialog.locale_name_placeholder',
                                        )}
                                        maxLength={NAME_MAX}
                                        dir="auto"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t(
                                            'categories.dialog.locale_remove',
                                        )}
                                        onClick={() =>
                                            set({
                                                names: values.names.filter(
                                                    (entry) =>
                                                        entry.id !== row.id,
                                                ),
                                            })
                                        }
                                    >
                                        <Trash2 aria-hidden />
                                    </Button>
                                </div>
                                {errors[`names.${row.id}`] && (
                                    <p className="text-sm text-red-600 dark:text-red-400">
                                        {errors[`names.${row.id}`]}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="category-add-translation"
                            disabled={
                                values.names.length >=
                                LIMITS.maxCategoryTranslations
                            }
                            onClick={() =>
                                set({
                                    names: [...values.names, newLocaleRow()],
                                })
                            }
                        >
                            <Plus aria-hidden />
                            {t('categories.dialog.add_translation')}
                        </Button>
                    </div>
                </FieldSet>

                <SwitchRow
                    id={`${uid}-active`}
                    label={t('categories.dialog.active')}
                    description={t('categories.dialog.active_hint')}
                    checked={values.isActive}
                    onCheckedChange={(isActive) => set({ isActive })}
                    testId="category-active-switch"
                />
            </div>

            <DialogFooter className="border-t bg-muted/30 px-5 py-3">
                <Button type="button" variant="outline" onClick={onCancel}>
                    {t('categories.dialog.cancel')}
                </Button>
                <Button
                    type="submit"
                    disabled={submitting}
                    data-testid="category-submit"
                >
                    {submitting && <Busy />}
                    {category
                        ? t('categories.dialog.save')
                        : t('categories.dialog.create')}
                </Button>
            </DialogFooter>
        </form>
    );
}
