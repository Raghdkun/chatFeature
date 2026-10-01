/** IANA time zones for the setup wizard's timezone select. */

const FALLBACK_ZONES = [
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Africa/Lagos',
    'America/Chicago',
    'America/Los_Angeles',
    'America/New_York',
    'America/Sao_Paulo',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Riyadh',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Europe/Berlin',
    'Europe/London',
    'Europe/Paris',
    'Pacific/Auckland',
];

/**
 * Legacy IANA names that `Intl.supportedValuesOf('timeZone')` still lists in many browsers (the
 * CLDR canonical id is the old spelling), mapped to the current canonical name. The server accepts
 * both (`timezone:all_with_bc`); the dashboard shows and sends the canonical one, so a saved
 * `Asia/Calcutta` and a freshly picked `Asia/Kolkata` are the same option.
 */
export const CANONICAL_ZONE: Readonly<Record<string, string>> = {
    'Africa/Asmera': 'Africa/Asmara',
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
    'America/Catamarca': 'America/Argentina/Catamarca',
    'America/Coral_Harbour': 'America/Atikokan',
    'America/Cordoba': 'America/Argentina/Cordoba',
    'America/Godthab': 'America/Nuuk',
    'America/Indianapolis': 'America/Indiana/Indianapolis',
    'America/Jujuy': 'America/Argentina/Jujuy',
    'America/Louisville': 'America/Kentucky/Louisville',
    'America/Mendoza': 'America/Argentina/Mendoza',
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Rangoon': 'Asia/Yangon',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Atlantic/Faeroe': 'Atlantic/Faroe',
    'Europe/Kiev': 'Europe/Kyiv',
    'Pacific/Ponape': 'Pacific/Pohnpei',
    'Pacific/Truk': 'Pacific/Chuuk',
};

/** The canonical name of a zone (the zone itself when it has no known alias). */
export function canonicalTimeZone(zone: string): string {
    return CANONICAL_ZONE[zone] ?? zone;
}

/**
 * Every time zone the browser knows (`Intl.supportedValuesOf('timeZone')`) under its canonical
 * name, without duplicates, always including UTC (some engines omit it) and `selected` (the saved
 * value, which the browser might not list, or might list under another spelling).
 */
export function getTimeZones(selected?: string): string[] {
    let zones: string[];

    try {
        zones = Intl.supportedValuesOf('timeZone');
    } catch {
        zones = FALLBACK_ZONES;
    }

    const all = new Set<string>(['UTC', ...zones.map(canonicalTimeZone)]);

    if (selected) {
        all.add(canonicalTimeZone(selected));
    }

    return [...all].sort((a, b) => a.localeCompare(b));
}

export type TimeZoneGroup = { region: string; zones: string[] };

/** Groups "Europe/Paris" under "Europe"; zones without a slash go under "Other". */
export function groupTimeZones(zones: string[]): TimeZoneGroup[] {
    const groups = new Map<string, string[]>();

    for (const zone of zones) {
        const region = zone.includes('/') ? zone.split('/')[0] : 'Other';

        groups.set(region, [...(groups.get(region) ?? []), zone]);
    }

    return [...groups.entries()].map(([region, list]) => ({
        region,
        zones: list,
    }));
}

/** "America/Argentina/Buenos_Aires" -> "Argentina / Buenos Aires" (region prefix dropped). */
export function formatTimeZone(zone: string): string {
    const parts = zone.split('/');

    return (parts.length > 1 ? parts.slice(1) : parts)
        .join(' / ')
        .replaceAll('_', ' ');
}
