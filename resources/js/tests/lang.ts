/** The English message table, loaded the same way the app bundles it (no JSON-module typing needed). */
const files = import.meta.glob<Record<string, string>>('/lang/en.json', {
    eager: true,
    import: 'default',
});

export const en: Record<string, string> = files['/lang/en.json'];
