/**
 * Code splitting for the parts of the panel the first screen does not need: the conversation (message list, composer, rating card,
 * attachments), the offline form and the two overlays. The idle panel (welcome, pre-chat, topics) stays small; `preloadHeavy()` is
 * called once the first screen has painted, so by the time a chat is queued the chunks are already there.
 *
 * `React.lazy` remembers a REJECTED import for good (a flaky network, a deploy that replaced the chunk): the components here are
 * wrappers that build a fresh `lazy()` on `reloadLazy()`, which the error boundary's "Try again" calls.
 */
import { lazy, type ComponentType } from 'react';

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

const resets: (() => void)[] = [];

/** `lazy()` whose import can be attempted again after a failure. */
export function lazyRetry<P extends object>(load: Loader<P>): ComponentType<P> {
    let Inner = lazy(load);
    const Wrapper = (props: P) => (
        <Inner {...(props as P & React.JSX.IntrinsicAttributes)} />
    );

    resets.push(() => {
        Inner = lazy(load);
    });

    return Wrapper;
}

/** Forget every failed import: the next render of a lazy component fetches its chunk again. */
export function reloadLazy(): void {
    for (const reset of resets) {
        reset();
    }
}

const chat = () => import('@/embed/components/screens/chat-screen');
const offline = () => import('@/embed/components/screens/offline-screen');
const overlays = () => import('@/embed/components/overlays');

export const ChatScreen = lazyRetry<object>(() =>
    chat().then((module) => ({ default: module.ChatScreen })),
);
export const OfflineScreen = lazyRetry<object>(() =>
    offline().then((module) => ({ default: module.OfflineScreen })),
);
export const Lightbox = lazyRetry<{ url: string; alt: string; ulid?: string }>(
    () => overlays().then((module) => ({ default: module.Lightbox })),
);
export const EndChatDialog = lazyRetry<{ onConfirm: () => void }>(() =>
    overlays().then((module) => ({ default: module.EndChatDialog })),
);

/** Fetch the split chunks (idempotent; failures are ignored, the lazy component retries on demand). */
export function preloadHeavy(): Promise<unknown> {
    return Promise.allSettled([chat(), offline(), overlays()]);
}
