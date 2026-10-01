import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    CANONICAL_ZONE,
    canonicalTimeZone,
    getTimeZones,
} from '@/lib/timezones';

afterEach(() => {
    vi.restoreAllMocks();
});

/** What Chrome / older ICU returns: legacy spellings, no Asia/Kolkata or Europe/Kyiv. */
const LEGACY_LIST = [
    'Asia/Calcutta',
    'Europe/Kiev',
    'Asia/Saigon',
    'Asia/Katmandu',
    'America/Buenos_Aires',
    'Asia/Rangoon',
    'Europe/Berlin',
    'America/New_York',
];

describe('canonicalTimeZone', () => {
    it.each([
        ['Asia/Calcutta', 'Asia/Kolkata'],
        ['Europe/Kiev', 'Europe/Kyiv'],
        ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
        ['Asia/Katmandu', 'Asia/Kathmandu'],
        ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
        ['Asia/Rangoon', 'Asia/Yangon'],
    ])('maps %s to %s', (legacy, canonical) => {
        expect(canonicalTimeZone(legacy)).toBe(canonical);
    });

    it('leaves canonical, unknown and empty values alone', () => {
        expect(canonicalTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
        expect(canonicalTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
        expect(canonicalTimeZone('UTC')).toBe('UTC');
        expect(canonicalTimeZone('Mars/Olympus_Mons')).toBe(
            'Mars/Olympus_Mons',
        );
        expect(canonicalTimeZone('')).toBe('');
    });

    it('only maps to names this engine accepts (so a pick can always be saved)', () => {
        for (const [legacy, canonical] of Object.entries(CANONICAL_ZONE)) {
            expect(
                () => new Intl.DateTimeFormat('en', { timeZone: legacy }),
                legacy,
            ).not.toThrow();
            expect(
                () => new Intl.DateTimeFormat('en', { timeZone: canonical }),
                canonical,
            ).not.toThrow();
        }
    });
});

describe('getTimeZones with an engine that lists legacy names', () => {
    it('shows the canonical names and none of the legacy ones', () => {
        vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(LEGACY_LIST);

        const zones = getTimeZones();

        for (const canonical of [
            'Asia/Kolkata',
            'Europe/Kyiv',
            'Asia/Ho_Chi_Minh',
            'Asia/Kathmandu',
            'America/Argentina/Buenos_Aires',
            'Asia/Yangon',
        ]) {
            expect(zones, canonical).toContain(canonical);
        }

        for (const legacy of [
            'Asia/Calcutta',
            'Europe/Kiev',
            'Asia/Saigon',
            'Asia/Katmandu',
            'America/Buenos_Aires',
            'Asia/Rangoon',
        ]) {
            expect(zones, legacy).not.toContain(legacy);
        }

        expect(zones).toContain('Europe/Berlin');
        expect(zones).toContain('UTC');
    });

    it('lists an alias once when the engine knows both spellings', () => {
        vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
            'Asia/Calcutta',
            'Asia/Kolkata',
            'Europe/Kiev',
            'Europe/Kyiv',
        ]);

        const zones = getTimeZones();

        expect(zones.filter((zone) => zone === 'Asia/Kolkata')).toHaveLength(1);
        expect(zones.filter((zone) => zone === 'Europe/Kyiv')).toHaveLength(1);
        expect(new Set(zones).size).toBe(zones.length);
    });

    it('round-trips a saved legacy value into the list under its canonical name', () => {
        vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(LEGACY_LIST);

        // The select shows `canonicalTimeZone(saved)`; that option has to exist.
        for (const saved of ['Asia/Calcutta', 'Europe/Kiev', 'Asia/Kolkata']) {
            expect(getTimeZones(saved)).toContain(canonicalTimeZone(saved));
        }
    });

    it('keeps a saved value the engine has never heard of', () => {
        vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(LEGACY_LIST);

        expect(getTimeZones('US/Pacific')).toContain('US/Pacific');
    });

    it('falls back to a built-in list when Intl cannot enumerate zones', () => {
        vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => {
            throw new RangeError('unsupported');
        });

        const zones = getTimeZones('Asia/Calcutta');

        expect(zones).toContain('UTC');
        expect(zones).toContain('Asia/Kolkata');
        expect(zones).not.toContain('Asia/Calcutta');
    });
});

describe('getTimeZones with the real engine', () => {
    it('is sorted, duplicate free and never lists a legacy alias', () => {
        const zones = getTimeZones();

        expect(new Set(zones).size).toBe(zones.length);
        expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));

        for (const legacy of Object.keys(CANONICAL_ZONE)) {
            expect(zones, legacy).not.toContain(legacy);
        }
    });
});
