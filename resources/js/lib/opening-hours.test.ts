import { describe, expect, it } from 'vite-plus/test';
import { hoursStatus } from '@/lib/opening-hours';
import type { HoursRange } from '@/types/widgets';

const WORKING_WEEK: HoursRange[] = [1, 2, 3, 4, 5].map((day) => ({
    day,
    start: '09:00',
    end: '17:00',
}));

describe('hoursStatus', () => {
    it('follows the schedule in the widget zone, not the browser zone', () => {
        // Wednesday 2026-10-07 10:00 UTC is 06:00 in New York (closed) and 12:00 in Cairo (open).
        const at = new Date('2026-10-07T10:00:00Z');

        expect(
            hoursStatus('auto_hours', 'America/New_York', WORKING_WEEK, [], at)
                .state,
        ).toBe('closed');
        expect(
            hoursStatus('auto_hours', 'Africa/Cairo', WORKING_WEEK, [], at)
                .state,
        ).toBe('open');
    });

    it('is closed at the end of a range and open at its start', () => {
        expect(
            hoursStatus(
                'auto_hours',
                'UTC',
                WORKING_WEEK,
                [],
                new Date('2026-10-07T17:00:00Z'),
            ).state,
        ).toBe('closed');
        expect(
            hoursStatus(
                'auto_hours',
                'UTC',
                WORKING_WEEK,
                [],
                new Date('2026-10-07T09:00:00Z'),
            ).state,
        ).toBe('open');
    });

    it('names the next opening: later today, or the next working day', () => {
        const early = hoursStatus(
            'auto_hours',
            'UTC',
            WORKING_WEEK,
            [],
            new Date('2026-10-07T06:00:00Z'),
        );
        const saturday = hoursStatus(
            'auto_hours',
            'UTC',
            WORKING_WEEK,
            [],
            new Date('2026-10-10T12:00:00Z'),
        );

        expect(early).toEqual({
            state: 'closed',
            next: { day: 3, start: '09:00', daysAhead: 0 },
        });
        expect(saturday).toEqual({
            state: 'closed',
            next: { day: 1, start: '09:00', daysAhead: 2 },
        });
    });

    it('skips a holiday', () => {
        const status = hoursStatus(
            'auto_hours',
            'UTC',
            WORKING_WEEK,
            [{ date: '2026-10-12', label: null }],
            new Date('2026-10-10T12:00:00Z'),
        );

        expect(status).toEqual({
            state: 'closed',
            next: { day: 2, start: '09:00', daysAhead: 3 },
        });
        expect(
            hoursStatus(
                'auto_hours',
                'UTC',
                WORKING_WEEK,
                [{ date: '2026-10-07', label: null }],
                new Date('2026-10-07T10:00:00Z'),
            ).state,
        ).toBe('closed');
    });

    it('never opens with an empty schedule, and ignores hours in the other modes', () => {
        const at = new Date('2026-10-07T10:00:00Z');

        expect(hoursStatus('auto_hours', 'UTC', [], [], at)).toEqual({
            state: 'closed',
            next: null,
        });
        expect(hoursStatus('always_online', 'UTC', [], [], at).state).toBe(
            'always_online',
        );
        expect(
            hoursStatus('always_offline', 'UTC', WORKING_WEEK, [], at).state,
        ).toBe('always_offline');
    });

    it('treats an unknown zone as UTC instead of throwing', () => {
        expect(
            hoursStatus(
                'auto_hours',
                'Mars/Olympus',
                WORKING_WEEK,
                [],
                new Date('2026-10-07T10:00:00Z'),
            ).state,
        ).toBe('open');
    });
});
