import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ChatController, Snapshot } from '@/embed/session/controller';
import type { Translate } from '@/embed/i18n';

export type PanelEnv = {
    mode: 'launcher' | 'inline' | 'hosted';
    preview: boolean;
    /** There is a loader to talk to (close button, Escape, viewport messages). */
    hasHost: boolean;
};

export const ControllerContext = createContext<ChatController | null>(null);
export const EnvContext = createContext<PanelEnv>({
    mode: 'launcher',
    preview: false,
    hasHost: true,
});

export function useController(): ChatController {
    const controller = useContext(ControllerContext);

    if (controller === null) {
        throw new Error('ChatController is not provided.');
    }

    return controller;
}

export function useSnapshot(): Snapshot {
    const controller = useController();

    return useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
    );
}

export function useT(): Translate {
    return useSnapshot().t;
}

export function useEnv(): PanelEnv {
    return useContext(EnvContext);
}

export type Overlay =
    | { type: 'image'; url: string; alt: string; ulid?: string }
    | { type: 'end' }
    | null;

export type OverlayApi = {
    overlay: Overlay;
    /** `ulid` names the attachment, so the lightbox follows its (refreshed) signed URL. */
    openImage: (url: string, alt: string, ulid?: string) => void;
    openEnd: () => void;
    close: () => void;
};

export const OverlayContext = createContext<OverlayApi>({
    overlay: null,
    openImage: () => undefined,
    openEnd: () => undefined,
    close: () => undefined,
});

export function useOverlay(): OverlayApi {
    return useContext(OverlayContext);
}
