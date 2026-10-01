import { router } from '@inertiajs/react';
import type { RequestPayload } from '@inertiajs/core';
import { useCallback, useState } from 'react';

export type SubmitErrors = Record<string, string>;

type SubmitCallbacks = {
    onSuccess?: () => void;
    onError?: (errors: SubmitErrors) => void;
    onFinish?: () => void;
};

/**
 * One Inertia visit with a plain object payload (`router.post|put`): the auth forms are controlled
 * (secrets, tag inputs, derived payloads), so they send a built object instead of a `<Form>`'s
 * FormData. Errors come back keyed by the server's field paths; they are cleared on every new
 * submit. Scroll is preserved so validation errors do not jump the page.
 */
export function useAuthFormSubmit() {
    const [errors, setErrors] = useState<SubmitErrors>({});
    const [processing, setProcessing] = useState(false);

    const submit = useCallback(
        (
            method: 'post' | 'put',
            url: string,
            data: RequestPayload,
            callbacks: SubmitCallbacks = {},
        ) => {
            router[method](url, data, {
                preserveScroll: true,
                onStart: () => {
                    setProcessing(true);
                    setErrors({});
                },
                onError: (found) => {
                    setErrors(found);
                    callbacks.onError?.(found);
                },
                onSuccess: () => callbacks.onSuccess?.(),
                onFinish: () => {
                    setProcessing(false);
                    callbacks.onFinish?.();
                },
            });
        },
        [],
    );

    const clearError = useCallback((...paths: string[]) => {
        setErrors((current) => {
            if (!paths.some((path) => path in current)) {
                return current;
            }

            const next = { ...current };

            for (const path of paths) {
                delete next[path];
            }

            return next;
        });
    }, []);

    return { errors, processing, submit, clearError };
}
