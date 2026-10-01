import { describe, expect, it } from 'vite-plus/test';
import { hasNoChatAccess } from '@/lib/login-notice';
import { roleOf } from '@/lib/roles';
import { formatTimeZone, getTimeZones, groupTimeZones } from '@/lib/timezones';
import { safeExternalUrl } from '@/lib/urls';

describe('roleOf', () => {
    it('lets admin win over agent and reports no access otherwise', () => {
        expect(roleOf({ is_admin: true, is_agent: true })).toBe('admin');
        expect(roleOf({ is_admin: true })).toBe('admin');
        expect(roleOf({ is_agent: true })).toBe('agent');
        expect(roleOf({ is_admin: false, is_agent: false })).toBe('none');
        expect(roleOf({})).toBe('none');
    });
});

describe('safeExternalUrl', () => {
    it('allows http and https links only', () => {
        expect(safeExternalUrl('https://auth.example.com')).toBe(
            'https://auth.example.com/',
        );
        expect(safeExternalUrl('http://localhost:8000/portal')).toBe(
            'http://localhost:8000/portal',
        );
        for (const bad of [
            'javascript:alert(1)',
            'data:text/html,hi',
            'ftp://x.test',
            '/relative',
            'not a url',
            '',
            null,
            undefined,
        ]) {
            expect(safeExternalUrl(bad)).toBeNull();
        }
    });
});

describe('hasNoChatAccess', () => {
    it('reads the reason prop or an `access` validation error', () => {
        expect(hasNoChatAccess({ reason: 'no_chat_access' })).toBe(true);
        expect(hasNoChatAccess({ errors: { access: 'x' } })).toBe(true);
        expect(hasNoChatAccess({ errors: { no_chat_access: 'x' } })).toBe(true);
    });

    it('ignores ordinary credential errors', () => {
        expect(hasNoChatAccess({})).toBe(false);
        expect(hasNoChatAccess({ reason: 'other' })).toBe(false);
        expect(hasNoChatAccess({ errors: { email: 'bad' } })).toBe(false);
    });
});

describe('time zones', () => {
    it('always offers UTC and the server default, without duplicates', () => {
        const zones = getTimeZones('Mars/Olympus_Mons');

        expect(zones).toContain('UTC');
        expect(zones).toContain('Mars/Olympus_Mons');
        expect(new Set(zones).size).toBe(zones.length);
        expect(zones.length).toBeGreaterThan(100);
    });

    it('groups by region and puts slash-less zones under Other', () => {
        const groups = groupTimeZones([
            'Europe/Berlin',
            'Europe/Paris',
            'UTC',
            'Asia/Dubai',
        ]);

        expect(groups).toEqual([
            { region: 'Europe', zones: ['Europe/Berlin', 'Europe/Paris'] },
            { region: 'Other', zones: ['UTC'] },
            { region: 'Asia', zones: ['Asia/Dubai'] },
        ]);
    });

    it('formats a zone without its region prefix', () => {
        expect(formatTimeZone('America/New_York')).toBe('New York');
        expect(formatTimeZone('America/Argentina/Buenos_Aires')).toBe(
            'Argentina / Buenos Aires',
        );
        expect(formatTimeZone('UTC')).toBe('UTC');
    });
});
