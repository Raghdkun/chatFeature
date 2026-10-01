/**
 * Form model of the category dialog: string fields in, the contract's request body out. Pure,
 * so the mapping (blank -> null, slug only when typed, per-locale rows -> `name_i18n`) is tested
 * without rendering anything.
 */
import type { ApiFieldErrors } from '@/lib/api-client';
import { LIMITS, SLUG_PATTERN } from '@/lib/limits';
import { humaniseField, withFieldLabel } from '@/lib/validation-messages';
import { isHexColor, isLocaleCode } from '@/lib/widget-config';
import type { CategoryData, CategoryInput } from '@/types/widgets';

export type LocaleRow = { id: string; locale: string; name: string };

export type CategoryFormValues = {
    name: string;
    slug: string;
    slugTouched: boolean;
    description: string;
    icon: string | null;
    color: string | null;
    isActive: boolean;
    names: LocaleRow[];
};

export const NAME_MAX = LIMITS.categoryNameLength;
export const SLUG_MAX = LIMITS.categorySlugLength;
export const DESCRIPTION_MAX = LIMITS.categoryDescriptionLength;

export function slugify(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX)
        .replace(/-+$/, '');
}

let rowCounter = 0;

export function newLocaleRow(locale = '', name = ''): LocaleRow {
    rowCounter += 1;

    return { id: `row-${rowCounter}`, locale, name };
}

export function emptyCategoryForm(): CategoryFormValues {
    return {
        name: '',
        slug: '',
        slugTouched: false,
        description: '',
        icon: 'message-circle',
        color: '#0f766e',
        isActive: true,
        names: [],
    };
}

export function categoryToForm(category: CategoryData): CategoryFormValues {
    return {
        name: category.name,
        slug: category.slug,
        slugTouched: true,
        description: category.description ?? '',
        icon: category.icon,
        color: category.color,
        isActive: category.is_active,
        names: Object.entries(category.name_i18n).map(([locale, name]) =>
            newLocaleRow(locale, name),
        ),
    };
}

export type CategoryFormErrors = Record<string, string>;

/** Client-side checks; `t` maps a message key to text. Returns field -> message. */
export function validateCategoryForm(
    values: CategoryFormValues,
    t: (key: string, replacements?: Record<string, string | number>) => string,
): CategoryFormErrors {
    const errors: CategoryFormErrors = {};

    if (values.name.trim() === '') {
        errors.name = t('categories.validation.name_required');
    } else if (values.name.length > NAME_MAX) {
        errors.name = t('categories.validation.too_long', { max: NAME_MAX });
    }

    if (values.slugTouched && values.slug.trim() !== '') {
        if (!SLUG_PATTERN.test(values.slug.trim())) {
            errors.slug = t('categories.validation.slug_format');
        } else if (values.slug.trim().length > SLUG_MAX) {
            errors.slug = t('categories.validation.too_long', {
                max: SLUG_MAX,
            });
        }
    }

    if (values.description.length > DESCRIPTION_MAX) {
        errors.description = t('categories.validation.too_long', {
            max: DESCRIPTION_MAX,
        });
    }

    if (values.color !== null && !isHexColor(values.color)) {
        errors.color = t('categories.validation.color');
    }

    const seen = new Set<string>();

    for (const row of values.names) {
        if (row.locale.trim() === '' && row.name.trim() === '') {
            continue;
        }

        if (!isLocaleCode(row.locale)) {
            errors[`names.${row.id}`] = t('categories.validation.locale');
        } else if (seen.has(row.locale.trim())) {
            errors[`names.${row.id}`] = t(
                'categories.validation.locale_duplicate',
            );
        } else if (row.name.trim() === '') {
            errors[`names.${row.id}`] = t(
                'categories.validation.name_required',
            );
        } else if (row.name.length > NAME_MAX) {
            errors[`names.${row.id}`] = t('categories.validation.too_long', {
                max: NAME_MAX,
            });
        }

        seen.add(row.locale.trim());
    }

    return errors;
}

/** The request body. A slug is only sent when the admin typed one; otherwise the server derives it. */
export function categoryRequestBody(
    values: CategoryFormValues,
    extra: { sortOrder?: number } = {},
): CategoryInput {
    const name_i18n: Record<string, string> = {};

    for (const row of values.names) {
        if (row.locale.trim() !== '' && row.name.trim() !== '') {
            name_i18n[row.locale.trim()] = row.name.trim();
        }
    }

    const body: CategoryInput = {
        name: values.name.trim(),
        description:
            values.description.trim() === '' ? null : values.description.trim(),
        icon: values.icon,
        color: values.color,
        is_active: values.isActive,
        name_i18n,
    };

    if (values.slugTouched && values.slug.trim() !== '') {
        body.slug = values.slug.trim();
    }

    if (extra.sortOrder !== undefined) {
        body.sort_order = extra.sortOrder;
    }

    return body;
}

/**
 * Maps the server's `details` onto the dialog's field keys (`name_i18n.xx` -> the matching row).
 * With `rowLabel` the server's text names the row ("Name in translation 2") instead of embedding
 * the dotted attribute ("The name i18n.ar must not be greater than ...").
 */
export function mapCategoryErrors(
    details: ApiFieldErrors,
    values: CategoryFormValues,
    rowLabel?: (position: number) => string,
): CategoryFormErrors {
    const errors: CategoryFormErrors = {};

    for (const [field, messages] of Object.entries(details)) {
        const message = messages[0];

        if (field.startsWith('name_i18n.')) {
            const locale = field.slice('name_i18n.'.length);
            const position = values.names.findIndex(
                (entry) => entry.locale.trim() === locale,
            );
            const row = values.names[position];
            const named = withFieldLabel(
                message,
                field,
                row && rowLabel ? rowLabel(position + 1) : humaniseField(field),
            );

            errors[row ? `names.${row.id}` : 'name_i18n'] = named;
        } else {
            errors[field] = message;
        }
    }

    return errors;
}

/** Orders by `sort_order`, then name (stable for ties). */
export function sortCategories<
    T extends Pick<CategoryData, 'sort_order' | 'name'>,
>(items: T[]): T[] {
    return [...items].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
    );
}

/**
 * New `sort_order` for every category whose position changed when `ulid` moves one step.
 * Positions become 0..n-1 so ties in the stored values cannot make the move a no-op.
 */
export function reorderCategories(
    items: CategoryData[],
    ulid: string,
    direction: -1 | 1,
): { ulid: string; sort_order: number }[] {
    const sorted = sortCategories(items);
    const from = sorted.findIndex((item) => item.ulid === ulid);
    const to = from + direction;

    if (from < 0 || to < 0 || to >= sorted.length) {
        return [];
    }

    const next = [...sorted];

    [next[from], next[to]] = [next[to], next[from]];

    return next
        .map((item, index) => ({ ulid: item.ulid, sort_order: index }))
        .filter(
            (change) =>
                items.find((item) => item.ulid === change.ulid)?.sort_order !==
                change.sort_order,
        );
}

export function nextSortOrder(items: CategoryData[]): number {
    return items.length === 0
        ? 0
        : Math.max(...items.map((item) => item.sort_order)) + 1;
}

export function matchesSearch(category: CategoryData, query: string): boolean {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
        return true;
    }

    return [category.name, category.slug, category.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
}
