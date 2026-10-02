import { createContext, useContext, useSyncExternalStore } from 'react';
import type {
    NotificationsController,
    NotificationsState,
} from '@/lib/notifications/controller';

export const NotificationsContext =
    createContext<NotificationsController | null>(null);

/** `null` outside the host (a page of a user who cannot chat, or a bare test). */
export function useNotificationsOptional(): NotificationsController | null {
    return useContext(NotificationsContext);
}

export function useNotifications(): NotificationsController {
    const controller = useContext(NotificationsContext);

    if (!controller) {
        throw new Error(
            'The notifications context is missing: render the page inside <NotificationsHost>.',
        );
    }

    return controller;
}

/** The live state of the notification session; one stable object per change, so it can feed `useSyncExternalStore`. */
export function useNotificationsState(
    controller: NotificationsController | null,
): NotificationsState | null {
    return useSyncExternalStore(
        controller ? controller.subscribe : noopSubscribe,
        () => (controller ? controller.getState() : null),
        () => null,
    );
}

function noopSubscribe(): () => void {
    return () => undefined;
}
