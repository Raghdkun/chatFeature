import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api-client';
import {
    checkAttachment,
    uploadAttachment,
    type AttachmentProblem,
    type UploadHandle,
} from '@/lib/chat-api/staff';
import type { AttachmentData } from '@/lib/chat/types';

export type PendingAttachment = {
    id: string;
    name: string;
    /** A local object URL for the thumbnail (empty where the browser cannot make one). */
    previewUrl: string;
    status: 'uploading' | 'ready' | 'error';
    /** 0..1 */
    progress: number;
    /** What the server stored (`ready` only). */
    data: AttachmentData | null;
    error: AttachmentProblem | 'failed' | null;
    /** The server's sentence for a rejected upload (size, type sniffed by the server, ...). */
    message: string | null;
};

type Upload = (
    conversation: string,
    file: File,
    onProgress?: (fraction: number) => void,
) => UploadHandle;

let counter = 0;

function previewFor(file: File): string {
    return typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : '';
}

function release(url: string): void {
    if (url !== '' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
    }
}

/**
 * Images the agent is attaching to the next message: each is checked (type, size) before it leaves the browser, uploaded at once
 * with progress, and can be removed (which cancels a running upload) until the message is sent.
 */
export function useAttachments(
    conversation: string,
    upload: Upload = uploadAttachment,
) {
    const [items, setItems] = useState<PendingAttachment[]>([]);
    const handles = useRef(new Map<string, UploadHandle>());
    const urls = useRef(new Map<string, string>());

    const patch = useCallback(
        (id: string, change: Partial<PendingAttachment>) =>
            setItems((current) =>
                current.map((item) =>
                    item.id === id ? { ...item, ...change } : item,
                ),
            ),
        [],
    );

    const add = useCallback(
        (files: File[]) => {
            for (const file of files) {
                counter += 1;

                const id = `attachment-${counter}`;
                const problem = checkAttachment(file);
                const previewUrl = problem ? '' : previewFor(file);

                urls.current.set(id, previewUrl);
                setItems((current) => [
                    ...current,
                    {
                        id,
                        name: file.name,
                        previewUrl,
                        status: problem ? 'error' : 'uploading',
                        progress: 0,
                        data: null,
                        error: problem,
                        message: null,
                    },
                ]);

                if (problem) {
                    continue;
                }

                const handle = upload(conversation, file, (fraction) =>
                    patch(id, { progress: fraction }),
                );

                handles.current.set(id, handle);
                handle.promise.then(
                    (data) => {
                        handles.current.delete(id);
                        patch(id, { status: 'ready', progress: 1, data });
                    },
                    (error: unknown) => {
                        handles.current.delete(id);

                        if (
                            error instanceof DOMException &&
                            error.name === 'AbortError'
                        ) {
                            return;
                        }

                        patch(id, {
                            status: 'error',
                            error: 'failed',
                            message: isApiError(error)
                                ? (error.firstMessage() ?? error.message)
                                : null,
                        });
                    },
                );
            }
        },
        [conversation, upload, patch],
    );

    const remove = useCallback((id: string) => {
        handles.current.get(id)?.abort();
        handles.current.delete(id);
        release(urls.current.get(id) ?? '');
        urls.current.delete(id);
        setItems((current) => current.filter((item) => item.id !== id));
    }, []);

    /** After a send: forget the items (the message holds the stored attachments now). */
    const clear = useCallback(() => {
        urls.current.forEach(release);
        urls.current.clear();
        setItems([]);
    }, []);

    useEffect(() => {
        const running = handles.current;
        const previews = urls.current;

        return () => {
            running.forEach((handle) => handle.abort());
            previews.forEach(release);
        };
    }, []);

    const ready = items.filter(
        (item): item is PendingAttachment & { data: AttachmentData } =>
            item.status === 'ready' && item.data !== null,
    );

    return {
        items,
        ready: ready.map((item) => item.data),
        uploading: items.some((item) => item.status === 'uploading'),
        add,
        remove,
        clear,
    };
}
