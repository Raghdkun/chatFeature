/**
 * Laravel's validation messages embed the failing attribute: "The config.hours.holidays.1.date
 * field has a duplicate value." (dots kept, camelCase turned into "snake case" words). Shown next to
 * a field, or in a toast, that reads like a stack trace. These helpers swap the embedded attribute
 * for the field's label and keep the server's rule text.
 */

/** What `:attribute` becomes for a key: `Str::snake`, underscores as spaces (dots stay). */
export function displayAttribute(field: string): string {
    return field
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replaceAll('_', ' ');
}

/**
 * A readable name for a field key nobody gave a label: leading `config` / `settings` dropped, list
 * positions as `#N` (1-based), the rest as lower-case words. `config.theme.primaryText` becomes
 * "theme primary text"; `greetings.0.body` becomes "greetings #1 body".
 */
export function humaniseField(field: string): string {
    const words = field
        .split('.')
        .filter(
            (segment, index) =>
                !(index === 0 && /^(config|settings)$/.test(segment)),
        )
        .map((segment) =>
            /^\d+$/.test(segment)
                ? `#${Number(segment) + 1}`
                : displayAttribute(segment),
        );

    return words.length > 0 ? words.join(' ') : field;
}

/**
 * `message` with every mention of the server's attribute for `field` replaced by `label`.
 * A message without the attribute (custom texts such as `"x.test" is not a valid domain`) is
 * returned unchanged.
 */
export function withFieldLabel(
    message: string,
    field: string,
    label: string,
): string {
    // The raw key first (it contains the displayed one for plain keys), then the "snake case" spelling.
    const spellings = [...new Set([field, displayAttribute(field)])].filter(
        (spelling) => spelling.includes('.') || spelling.includes(' '),
    );

    return spellings.reduce(
        (text, spelling) => text.split(spelling).join(label),
        message,
    );
}
