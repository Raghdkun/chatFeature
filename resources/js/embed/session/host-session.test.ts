import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { createHostSessionLink } from '@/embed/session/host-session';

const newer = { token: 'vt_new', expiresAt: '2030-01-01T00:00:00.000Z' };

describe('host session link', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends the drop and resolves with the newer session the host answers with', async () => {
        const sent: string[] = [];
        const link = createHostSessionLink((token) => sent.push(token));
        const result = link.drop('vt_old');

        expect(sent).toEqual(['vt_old']);
        link.answer(newer);

        await expect(result).resolves.toEqual(newer);
    });

    it('resolves null when the host says nothing newer exists', async () => {
        const link = createHostSessionLink(() => undefined);
        const result = link.drop('vt_old');

        link.answer(null);

        await expect(result).resolves.toBeNull();
    });

    it('gives up after the timeout (a loader that predates the answer): cleared', async () => {
        const link = createHostSessionLink(() => undefined, 1500);
        const result = link.drop('vt_old');

        await vi.advanceTimersByTimeAsync(1500);

        await expect(result).resolves.toBeNull();
        // a late answer finds nobody waiting and changes nothing
        expect(() => link.answer(newer)).not.toThrow();
    });

    it('answers pending drops in order', async () => {
        const link = createHostSessionLink(() => undefined);
        const first = link.drop('a');
        const second = link.drop('b');

        link.answer(newer);
        link.answer(null);

        await expect(first).resolves.toEqual(newer);
        await expect(second).resolves.toBeNull();
    });
});
