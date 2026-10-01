import { useEffect, useRef, useState } from 'react';
import {
    MAX_ATTACHMENTS,
    type ChatController,
} from '@/embed/session/controller';
import { MAX_ATTACHMENT_BYTES, precheckImage } from '@/embed/lib/attachments';
import { isVisitorApiError } from '@/lib/chat-api/visitor';
import type { AttachmentData } from '@/lib/chat/types';

export type Staged = {
    id: string;
    name: string;
    /** `blob:` URL of the local file, for the thumbnail until the message is sent. */
    previewUrl: string;
    progress: number;
    status: 'uploading' | 'ready' | 'error';
    attachment: AttachmentData | null;
};

export type AttachmentProblem =
    | 'type'
    | 'size'
    | 'count'
    | 'upload'
    | 'rejected'
    | 'disabled'
    | 'rate_limited'
    | null;

/** What the server's refusal of an upload means to the visitor (`422` content / size, `403 feature_disabled`, `429`). */
export function problemOf(error: unknown): Exclude<AttachmentProblem, null> {
    if (!isVisitorApiError(error)) {
        return 'upload';
    }

    if (error.code === 'feature_disabled') {
        return 'disabled';
    }

    if (error.status === 429) {
        return 'rate_limited';
    }

    return error.status === 422 ? 'rejected' : 'upload';
}

let counter = 0;

/**
 * Images the visitor picked for the next message: prechecked (type, size), uploaded at once with progress, removable until the
 * message is sent. `take()` hands the uploaded ones to the message and forgets them.
 */
export function useAttachments(
    controller: ChatController,
    maxBytes: number = MAX_ATTACHMENT_BYTES,
    maxCount: number = MAX_ATTACHMENTS,
) {
    const [items, setItems] = useState<Staged[]>([]);
    const [problem, setProblem] = useState<AttachmentProblem>(null);
    const aborts = useRef(new Map<string, AbortController>());
    const itemsRef = useRef<Staged[]>([]);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    useEffect(() => {
        const running = aborts.current;

        return () => {
            for (const abort of running.values()) {
                abort.abort();
            }

            for (const item of itemsRef.current) {
                URL.revokeObjectURL(item.previewUrl);
            }
        };
    }, []);

    const patch = (id: string, change: Partial<Staged>): void =>
        setItems((current) =>
            current.map((item) =>
                item.id === id ? { ...item, ...change } : item,
            ),
        );

    const start = (file: File): void => {
        const id = `staged-${++counter}`;
        const abort = new AbortController();

        aborts.current.set(id, abort);
        setItems((current) => [
            ...current,
            {
                id,
                name: file.name,
                previewUrl: URL.createObjectURL(file),
                progress: 0,
                status: 'uploading',
                attachment: null,
            },
        ]);

        controller
            .uploadAttachment(file, {
                signal: abort.signal,
                onProgress: (progress) => patch(id, { progress }),
            })
            .then((attachment) =>
                patch(id, { status: 'ready', progress: 1, attachment }),
            )
            .catch((error: unknown) => {
                if (isVisitorApiError(error) && error.code === 'aborted') {
                    return;
                }

                patch(id, { status: 'error' });
                setProblem(problemOf(error));
            })
            .finally(() => aborts.current.delete(id));
    };

    const add = (files: readonly File[]): void => {
        setProblem(null);

        let room = maxCount - itemsRef.current.length;

        for (const file of files) {
            const check = precheckImage(file, maxBytes);

            if (!check.ok) {
                setProblem(check.reason);

                continue;
            }

            if (room <= 0) {
                setProblem('count');

                break;
            }

            room -= 1;
            start(file);
        }
    };

    const remove = (id: string): void => {
        aborts.current.get(id)?.abort();
        aborts.current.delete(id);
        setProblem(null);
        setItems((current) => {
            const gone = current.find((item) => item.id === id);

            if (gone !== undefined) {
                URL.revokeObjectURL(gone.previewUrl);
            }

            return current.filter((item) => item.id !== id);
        });
    };

    const take = (): AttachmentData[] => {
        const ready = itemsRef.current.flatMap((item) =>
            item.status === 'ready' && item.attachment !== null
                ? [item.attachment]
                : [],
        );

        for (const item of itemsRef.current) {
            URL.revokeObjectURL(item.previewUrl);
        }

        setItems([]);
        setProblem(null);

        return ready;
    };

    return {
        items,
        problem,
        add,
        remove,
        take,
        uploading: items.some((item) => item.status === 'uploading'),
        readyCount: items.filter((item) => item.status === 'ready').length,
    };
}
