/**
 * The inbox list: the chats of the current filters, read over REST (page 1 and "load more"), kept live by the store (the websocket's
 * `wa.chat.updated` / `wa.message.created` change a row, move it to the top, add a chat that matches), and read again every 15 s while the
 * websocket is down. The store is the single copy of every chat; this hook only decides WHICH chats are listed and in what order.
 *
 * A search (`q`) is answered by the server alone (it looks into message texts): while one is active only the chats it returned are
 * listed (updated live), and chats the websocket brings are not added, because the browser cannot tell whether they match.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    useWaRealtime,
    useWaRetain,
    useWaState,
    useWaWatch,
} from '@/lib/realtime/whatsapp/context';
import { POLL_INTERVAL_MS } from '@/lib/realtime/whatsapp/controller';
import { byRecency } from '@/lib/realtime/whatsapp/store';
import type { WaApi } from '@/lib/whatsapp-api/client';
import type { WaChat } from '@/lib/whatsapp/types';

export type WaListFilters = {
    status: 'open' | 'archived' | 'all';
    /** A session's ulid, or `''` for every session. */
    session: string;
    /** A widget's ulid, or `''` for every widget. */
    widget: string;
    /** A topic's slug, or `''` for every topic. */
    category: string;
    linked: 'all' | 'linked' | 'unlinked';
    unreadOnly: boolean;
    sort: 'recent' | 'unread';
    q: string;
};

export const DEFAULT_WA_FILTERS: WaListFilters = {
    status: 'open',
    session: '',
    widget: '',
    category: '',
    linked: 'all',
    unreadOnly: false,
    sort: 'recent',
    q: '',
};

export const SEARCH_DEBOUNCE_MS = 300;
export const LIST_PAGE_LIMIT = 50;

/** Does this chat belong in a list with these filters? (Everything except the text search, which only the server can answer.) */
export function matchesFilters(chat: WaChat, filters: WaListFilters): boolean {
    return (
        (filters.status === 'all' || chat.status === filters.status) &&
        (filters.session === '' || chat.session.ulid === filters.session) &&
        (filters.widget === '' || chat.widget?.ulid === filters.widget) &&
        (filters.category === '' || chat.category?.slug === filters.category) &&
        (filters.linked === 'all' ||
            chat.linked === (filters.linked === 'linked')) &&
        (!filters.unreadOnly || chat.unreadByAdmin > 0)
    );
}

function sameFilters(a: WaListFilters, b: WaListFilters): boolean {
    return (
        a.status === b.status &&
        a.session === b.session &&
        a.widget === b.widget &&
        a.category === b.category &&
        a.linked === b.linked &&
        a.unreadOnly === b.unreadOnly &&
        a.sort === b.sort &&
        a.q === b.q
    );
}

/** Recent first; with "unread first" the chats with something unread lead, each group by recency. */
export function sortChats(
    chats: WaChat[],
    sort: WaListFilters['sort'],
): WaChat[] {
    return [...chats].sort((a, b) => {
        if (sort === 'unread') {
            const unread =
                Number(b.unreadByAdmin > 0) - Number(a.unreadByAdmin > 0);

            if (unread !== 0) {
                return unread;
            }
        }

        return byRecency(a, b);
    });
}

export function useWaChatList({
    initialChats,
    initialCursor,
    initialHasMore,
    api: injectedApi,
}: {
    initialChats: WaChat[];
    /** The API's cursor of the second page, when the page props carry it (6A's own page controller does). */
    initialCursor: string | null;
    /** The page props carry only the first page: there is more, and (without a cursor) the first read over the API says where it continues. */
    initialHasMore: boolean;
    api?: WaApi;
}) {
    const { store, api: contextApi } = useWaRealtime();
    const api = injectedApi ?? contextApi;

    useWaRetain();
    useWaWatch();

    const connection = useWaState((state) => state.connection);
    const known = useWaState((state) => state.chats);
    const [filters, setFilters] = useState<WaListFilters>(DEFAULT_WA_FILTERS);
    const [applied, setApplied] = useState<WaListFilters>(DEFAULT_WA_FILTERS);
    const [ids, setIds] = useState<string[]>(() =>
        initialChats.map((chat) => chat.ulid),
    );
    const [cursor, setCursor] = useState<string | null>(initialCursor);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const request = useRef(0);

    // The page props are the first picture of the list.
    useEffect(() => {
        store.dispatch({
            type: 'chatsLoaded',
            chats: initialChats,
            since: store.getState().clock,
        });
    }, [store, initialChats]);

    // The search box is debounced; the other filters apply at once. An unchanged value keeps the same object (no pointless re-read).
    useEffect(() => {
        const timer = setTimeout(
            () =>
                setApplied((held) =>
                    sameFilters(held, filters) ? held : filters,
                ),
            filters.q === applied.q ? 0 : SEARCH_DEBOUNCE_MS,
        );

        return () => clearTimeout(timer);
    }, [filters, applied.q]);

    const query = useCallback(
        (from: string | null) =>
            api.chats({
                status: applied.status,
                session: applied.session === '' ? undefined : applied.session,
                widget: applied.widget === '' ? undefined : applied.widget,
                category:
                    applied.category === '' ? undefined : applied.category,
                linked:
                    applied.linked === 'all'
                        ? undefined
                        : applied.linked === 'linked',
                unread: applied.unreadOnly,
                q: applied.q.trim(),
                cursor: from,
                limit: LIST_PAGE_LIMIT,
            }),
        [api, applied],
    );

    /**
     * Read page 1 of the current filters. `quiet`: a background refresh (the poll): no spinner, and the rows already loaded stay.
     * `keepRows`: only learn the cursor and add rows (the first read after the props).
     */
    const reload = useCallback(
        async (quiet = false, keepRows = false): Promise<void> => {
            const mine = (request.current += 1);
            const since = store.getState().clock;

            if (!quiet) {
                setLoading(true);
            }

            try {
                const page = await query(null);

                if (mine !== request.current) {
                    return;
                }

                store.dispatch({
                    type: 'chatsLoaded',
                    chats: page.chats,
                    since,
                });
                setIds((held) =>
                    quiet || keepRows
                        ? [
                              ...new Set([
                                  ...page.chats.map((chat) => chat.ulid),
                                  ...held,
                              ]),
                          ]
                        : page.chats.map((chat) => chat.ulid),
                );

                if (!quiet || keepRows) {
                    setCursor(page.nextCursor);
                }

                setError(false);
            } catch {
                if (mine === request.current && !quiet) {
                    setError(true);
                }
            } finally {
                if (mine === request.current && !quiet) {
                    setLoading(false);
                }
            }
        },
        [query, store],
    );

    // A changed filter (or search) reads page 1 again. The first render keeps the props, and reads page 1 once, quietly, only when there
    // is more than the props carry (that answer holds the cursor "load more" continues from).
    const firstRun = useRef(true);

    useEffect(() => {
        if (firstRun.current) {
            firstRun.current = false;

            if (initialHasMore && initialCursor === null) {
                void reload(false, true);
            }

            return;
        }

        void reload();
    }, [reload, initialHasMore, initialCursor]);

    const loadMore = useCallback(async (): Promise<void> => {
        if (cursor === null || loading) {
            return;
        }

        const mine = (request.current += 1);
        const since = store.getState().clock;

        setLoading(true);

        try {
            const page = await query(cursor);

            if (mine !== request.current) {
                return;
            }

            store.dispatch({ type: 'chatsLoaded', chats: page.chats, since });
            setIds((held) => [
                ...new Set([...held, ...page.chats.map((chat) => chat.ulid)]),
            ]);
            setCursor(page.nextCursor);
            setError(false);
        } catch {
            if (mine === request.current) {
                setError(true);
            }
        } finally {
            if (mine === request.current) {
                setLoading(false);
            }
        }
    }, [cursor, loading, query, store]);

    // No websocket (or it dropped): read the first page again every 15 s.
    useEffect(() => {
        if (connection === 'connected') {
            return;
        }

        const timer = setInterval(() => void reload(true), POLL_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [connection, reload]);

    const searching = applied.q.trim() !== '';

    const chats = useMemo(() => {
        const listed = new Set(ids);
        const rows: WaChat[] = [];

        for (const id of ids) {
            const chat = known[id];

            if (chat !== undefined && matchesFilters(chat, applied)) {
                rows.push(chat);
            }
        }

        if (!searching) {
            for (const chat of Object.values(known)) {
                if (!listed.has(chat.ulid) && matchesFilters(chat, applied)) {
                    rows.push(chat);
                }
            }
        }

        return sortChats(rows, applied.sort);
    }, [ids, known, applied, searching]);

    return {
        chats,
        filters,
        setFilters,
        applied,
        loading,
        error,
        hasMore: cursor !== null,
        loadMore,
        reload: () => reload(),
        searching,
        connection,
    };
}
