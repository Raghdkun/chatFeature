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
 * Every time zone the browser knows (`Intl.supportedValuesOf('timeZone')`), always
 * including UTC (some engines omit it) and `selected` (the server default, which the
 * browser might not list).
 */
export function getTimeZones(selected?: string): string[] {
    let zones: string[];

    try {
        zones = Intl.supportedValuesOf('timeZone');
    } catch {
        zones = FALLBACK_ZONES;
    }

    const all = new Set<string>(['UTC', ...zones]);

    if (selected) {
        all.add(selected);
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
