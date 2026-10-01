import { describe, expect, it } from 'vite-plus/test';
import {
    categoryRequestBody,
    categoryToForm,
    emptyCategoryForm,
    mapCategoryErrors,
    matchesSearch,
    newLocaleRow,
    nextSortOrder,
    reorderCategories,
    slugify,
    sortCategories,
    validateCategoryForm,
} from '@/components/categories/category-form';
import { CATEGORIES, makeCategory } from '@/tests/fixtures';

const t = (key: string) => key;

describe('slugify', () => {
    it('makes url-safe lower-case slugs', () => {
        expect(slugify('Technical Support')).toBe('technical-support');
        expect(slugify('  Billing & Invoices!  ')).toBe('billing-invoices');
        expect(slugify('Café Crème')).toBe('cafe-creme');
        expect(slugify('---')).toBe('');
        expect(slugify('a'.repeat(120))).toHaveLength(64);
        // A cut never leaves a trailing dash (the server pattern rejects it).
        expect(slugify(`${'a'.repeat(63)}-bcd`)).toBe('a'.repeat(63));
    });
});

describe('category request body', () => {
    it('sends blank description as null and no slug unless the admin typed one', () => {
        const form = { ...emptyCategoryForm(), name: '  Sales  ' };

        expect(categoryRequestBody(form, { sortOrder: 4 })).toEqual({
            name: 'Sales',
            description: null,
            icon: 'message-circle',
            color: '#0f766e',
            is_active: true,
            name_i18n: {},
            sort_order: 4,
        });
    });

    it('includes a typed slug and the per-locale names (blank rows skipped)', () => {
        const form = {
            ...emptyCategoryForm(),
            name: 'Sales',
            slug: 'sales-team',
            slugTouched: true,
            description: ' Quotes ',
            names: [
                newLocaleRow('ar', ' المبيعات '),
                newLocaleRow('', ''),
                newLocaleRow('fr', ''),
            ],
        };
        const body = categoryRequestBody(form);

        expect(body.slug).toBe('sales-team');
        expect(body.description).toBe('Quotes');
        expect(body.name_i18n).toEqual({ ar: 'المبيعات' });
        expect(body).not.toHaveProperty('sort_order');
    });

    it('round-trips an existing category into the form and back', () => {
        const category = makeCategory({
            name_i18n: { ar: 'المبيعات' },
            description: null,
        });
        const form = categoryToForm(category);

        expect(form.slugTouched).toBe(true);
        expect(form.names).toMatchObject([{ locale: 'ar', name: 'المبيعات' }]);
        expect(categoryRequestBody(form)).toMatchObject({
            name: 'Sales',
            slug: 'sales',
            description: null,
            icon: 'shopping-cart',
            color: '#2563eb',
            name_i18n: { ar: 'المبيعات' },
        });
    });
});

describe('validateCategoryForm', () => {
    it('accepts the empty-but-named form', () => {
        expect(
            validateCategoryForm({ ...emptyCategoryForm(), name: 'Sales' }, t),
        ).toEqual({});
    });

    it('flags missing name, bad slug, bad color and bad translations', () => {
        const row = newLocaleRow('English', 'x');
        const duplicate = newLocaleRow('ar', 'a');
        const duplicate2 = newLocaleRow('ar', 'b');
        const noName = newLocaleRow('fr', ' ');
        const errors = validateCategoryForm(
            {
                ...emptyCategoryForm(),
                name: ' ',
                slug: 'Bad Slug',
                slugTouched: true,
                color: 'teal',
                description: 'x'.repeat(1001),
                names: [row, duplicate, duplicate2, noName],
            },
            t,
        );

        expect(errors.name).toBe('categories.validation.name_required');
        expect(errors.slug).toBe('categories.validation.slug_format');
        expect(errors.color).toBe('categories.validation.color');
        expect(errors.description).toBe('categories.validation.too_long');
        expect(errors[`names.${row.id}`]).toBe('categories.validation.locale');
        expect(errors[`names.${duplicate2.id}`]).toBe(
            'categories.validation.locale_duplicate',
        );
        expect(errors[`names.${noName.id}`]).toBe(
            'categories.validation.name_required',
        );
        expect(errors).not.toHaveProperty(`names.${duplicate.id}`);
    });

    it('does not validate an untouched auto slug', () => {
        expect(
            validateCategoryForm(
                { ...emptyCategoryForm(), name: 'Sales', slug: 'NOT valid' },
                t,
            ),
        ).toEqual({});
    });
});

describe('mapCategoryErrors', () => {
    it('maps field errors and attaches name_i18n errors to their row', () => {
        const row = newLocaleRow('ar', 'x');
        const values = { ...emptyCategoryForm(), names: [row] };

        expect(
            mapCategoryErrors(
                {
                    slug: ['Taken'],
                    'name_i18n.ar': ['Too long'],
                    'name_i18n.zz': ['?'],
                },
                values,
            ),
        ).toEqual({
            slug: 'Taken',
            [`names.${row.id}`]: 'Too long',
            name_i18n: '?',
        });
    });
});

describe('ordering', () => {
    it('sorts by sort_order then name', () => {
        const items = [
            makeCategory({ ulid: 'a', name: 'Zed', sort_order: 1 }),
            makeCategory({ ulid: 'b', name: 'Alpha', sort_order: 1 }),
            makeCategory({ ulid: 'c', name: 'Mid', sort_order: 0 }),
        ];

        expect(sortCategories(items).map((c) => c.ulid)).toEqual([
            'c',
            'b',
            'a',
        ]);
    });

    it('swaps with the neighbour and renumbers so ties cannot make a move a no-op', () => {
        expect(reorderCategories(CATEGORIES, 'cat2', -1)).toEqual([
            { ulid: 'cat2', sort_order: 0 },
            { ulid: 'cat1', sort_order: 1 },
        ]);
        expect(reorderCategories(CATEGORIES, 'cat1', 1)).toEqual([
            { ulid: 'cat2', sort_order: 0 },
            { ulid: 'cat1', sort_order: 1 },
        ]);

        const tied = [
            makeCategory({ ulid: 'a', name: 'A', sort_order: 0 }),
            makeCategory({ ulid: 'b', name: 'B', sort_order: 0 }),
            makeCategory({ ulid: 'c', name: 'C', sort_order: 0 }),
        ];

        expect(reorderCategories(tied, 'c', -1)).toEqual([
            { ulid: 'c', sort_order: 1 },
            { ulid: 'b', sort_order: 2 },
        ]);
    });

    it('does nothing past either end or for an unknown category', () => {
        expect(reorderCategories(CATEGORIES, 'cat1', -1)).toEqual([]);
        expect(reorderCategories(CATEGORIES, 'cat3', 1)).toEqual([]);
        expect(reorderCategories(CATEGORIES, 'nope', 1)).toEqual([]);
    });

    it('puts a new category at the end', () => {
        expect(nextSortOrder([])).toBe(0);
        expect(nextSortOrder(CATEGORIES)).toBe(3);
    });
});

describe('matchesSearch', () => {
    it('matches name, slug and description case-insensitively', () => {
        expect(matchesSearch(CATEGORIES[0], 'SALES')).toBe(true);
        expect(matchesSearch(CATEGORIES[0], 'quotes')).toBe(true);
        expect(matchesSearch(CATEGORIES[1], 'billing')).toBe(true);
        expect(matchesSearch(CATEGORIES[1], 'sales')).toBe(false);
        expect(matchesSearch(CATEGORIES[1], '   ')).toBe(true);
    });
});
