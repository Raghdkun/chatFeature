/**
 * Code splitting for the parts of the panel the first screen does not need: the conversation (message list, composer, rating card,
 * attachments), the offline form and the two overlays. The idle panel (welcome, pre-chat, topics) stays small; `preloadHeavy()` is
 * called once the first screen has painted, so by the time a chat is queued the chunks are already there.
 */
import { lazy } from 'react';

const chat = () => import('@/embed/components/screens/chat-screen');
const offline = () => import('@/embed/components/screens/offline-screen');
const overlays = () => import('@/embed/components/overlays');

export const ChatScreen = lazy(() =>
    chat().then((module) => ({ default: module.ChatScreen })),
);
export const OfflineScreen = lazy(() =>
    offline().then((module) => ({ default: module.OfflineScreen })),
);
export const Lightbox = lazy(() =>
    overlays().then((module) => ({ default: module.Lightbox })),
);
export const EndChatDialog = lazy(() =>
    overlays().then((module) => ({ default: module.EndChatDialog })),
);

/** Fetch the split chunks (idempotent; failures are ignored, the lazy component retries on demand). */
export function preloadHeavy(): Promise<unknown> {
    return Promise.allSettled([chat(), offline(), overlays()]);
}
