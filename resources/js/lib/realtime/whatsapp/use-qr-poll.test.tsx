import { act } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ApiError } from '@/lib/api-client';
import {
    QR_POLL_MS,
    useQrPoll,
    type QrView,
} from '@/lib/realtime/whatsapp/use-qr-poll';
import type { WaApi } from '@/lib/whatsapp-api/client';
import type { QrResult } from '@/lib/whatsapp-api/types';
import { render } from '@/tests/render';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function setup(replies: (QrResult | Error)[]) {
    const queue = [...replies];
    const qr = vi.fn(async (_ulid: string, _signal?: AbortSignal) => {
        const next = queue.length > 1 ? queue.shift() : queue[0];

        if (next instanceof Error) {
            throw next;
        }

        return next as QrResult;
    });
    const api = { qr } as unknown as WaApi;
    const onReady = vi.fn();
    const seen: QrView[] = [];
    let refresh: () => void = () => undefined;

    function Probe({ open, ulid }: { open: boolean; ulid: string | null }) {
        const poll = useQrPoll({ ulid, open, api, onReady });

        seen.push(poll.view);
        refresh = poll.refresh;

        return <span data-testid="kind">{poll.view.kind}</span>;
    }

    return { qr, onReady, seen, Probe, refresh: () => refresh() };
}

const shows = (kind: string) =>
    document.body.querySelector('[data-testid="kind"]')?.textContent === kind;

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the QR poll', () => {
    it('reads at once, shows the picture, and reads again every 2.5 seconds', async () => {
        const { qr, Probe } = setup([
            { status: 'qr', image: PNG, updatedAt: null },
        ]);

        await render(<Probe open ulid="s1" />);
        expect(qr).toHaveBeenCalledTimes(1);
        expect(shows('qr')).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS);
        });
        expect(qr).toHaveBeenCalledTimes(2);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS * 2);
        });
        expect(qr).toHaveBeenCalledTimes(4);
        expect(qr.mock.calls[0][0]).toBe('s1');
    });

    it('says "waiting" while the engine starts, then shows the code when it appears', async () => {
        const { Probe } = setup([
            { status: 'starting', image: null, updatedAt: null },
            { status: 'qr', image: PNG, updatedAt: null },
        ]);

        await render(<Probe open ulid="s1" />);
        expect(shows('waiting')).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS);
        });
        expect(shows('qr')).toBe(true);
    });

    it('stops and calls back when the session is connected', async () => {
        const { qr, onReady, Probe } = setup([
            { status: 'qr', image: PNG, updatedAt: null },
            { status: 'ready', image: null, updatedAt: null },
        ]);

        await render(<Probe open ulid="s1" />);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS);
        });

        expect(shows('ready')).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS * 4);
        });
        expect(qr).toHaveBeenCalledTimes(2);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it.each(['created', 'disconnected', 'failed'] as const)(
        'stops polling when the session is %s: no code will come until it is started again',
        async (status) => {
            const { qr, Probe } = setup([
                { status, image: null, updatedAt: null },
            ]);

            await render(<Probe open ulid="s1" />);
            expect(shows('stopped')).toBe(true);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(QR_POLL_MS * 4);
            });
            expect(qr).toHaveBeenCalledTimes(1);
        },
    );

    it('shows a failed read and keeps polling', async () => {
        const { qr, Probe } = setup([
            new ApiError({
                status: 503,
                code: 'openwa_unavailable',
                message: 'down',
            }),
            { status: 'qr', image: PNG, updatedAt: null },
        ]);

        await render(<Probe open ulid="s1" />);
        expect(shows('error')).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS);
        });
        expect(qr).toHaveBeenCalledTimes(2);
        expect(shows('qr')).toBe(true);
    });

    it('does not read while closed, stops when it closes, and aborts the read in flight', async () => {
        const { qr, Probe } = setup([
            { status: 'qr', image: PNG, updatedAt: null },
        ]);
        const view = await render(<Probe open={false} ulid="s1" />);

        expect(qr).not.toHaveBeenCalled();
        await view.unmount();

        const open = setup([{ status: 'qr', image: PNG, updatedAt: null }]);
        const second = await render(<open.Probe open ulid="s1" />);

        await second.unmount();
        const before = open.qr.mock.calls.length;

        await act(async () => {
            await vi.advanceTimersByTimeAsync(QR_POLL_MS * 4);
        });
        expect(open.qr.mock.calls.length).toBe(before);
        expect(open.qr.mock.calls[0][1]?.aborted).toBe(true);
    });

    it('reads again at once when asked to refresh', async () => {
        const { qr, Probe, refresh } = setup([
            { status: 'qr', image: PNG, updatedAt: null },
        ]);

        await render(<Probe open ulid="s1" />);
        expect(qr).toHaveBeenCalledTimes(1);

        await act(async () => refresh());
        expect(qr).toHaveBeenCalledTimes(2);
    });
});
