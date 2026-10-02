/**
 * The notification session of the page, mounted ONCE inside the staff host (`app.tsx`): like the websocket, it must outlive every
 * visit, so it sits above the Inertia pages and learns who is signed in from the router's `navigate` events instead of `usePage()`.
 *
 * It owns the controller (`lib/notifications/controller`), shares it with the pages through a context (the settings page reads it),
 * mounts the first-login dialog, keeps the page's own OS notifications silent in the member's quiet hours, applies the server's sound
 * preference to the sound player, and opens the chat a clicked notification points at.
 */
import { router } from '@inertiajs/react';
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import { NotificationPrompt } from '@/components/notifications/notification-prompt';
import { i18n } from '@/hooks/use-trans';
import { NotificationsContext } from '@/lib/notifications/context';
import {
    createNotificationsController,
    osPreferencesOf,
    type NotificationsController,
    type NotificationsDeps,
} from '@/lib/notifications/controller';
import { isQuietNow } from '@/lib/notifications/quiet-hours';
import { notificationRoutes } from '@/lib/notifications/routes';
import { useStaffRealtimeOptional } from '@/lib/realtime/staff/context';
import { identityOf } from '@/lib/realtime/staff/host';
import {
    resetOsNotificationPolicy,
    setOsNotificationPolicy,
} from '@/lib/realtime/staff/os-notification';

type PageLike = { props: Record<string, unknown>; url?: string };

/** The public VAPID key the server shares with signed-in staff (`push` prop), or `null` when push is not configured. */
export function pushKeyOf(page: PageLike): string | null {
    const push = page.props.push as
        | { vapidPublicKey?: unknown }
        | null
        | undefined;

    return typeof push?.vapidPublicKey === 'string' &&
        push.vapidPublicKey !== ''
        ? push.vapidPublicKey
        : null;
}

/** `useTrans()` for code that sits outside the Inertia page context. */
function useTranslatorFor(locale: string) {
    useEffect(() => {
        void i18n.load(locale);
    }, [locale]);

    return useSyncExternalStore(
        i18n.subscribe,
        () => i18n.translatorFor(locale),
        () => i18n.translatorFor(locale),
    );
}

export type NotificationsHostProps = {
    /** The first page (`withApp` hands it over); later visits arrive through the router's `navigate` event. */
    initialPage: PageLike;
    children: ReactNode;
    /** Test doubles for the controller's browser, API and storage. */
    deps?: Partial<
        Pick<
            NotificationsDeps,
            'api' | 'env' | 'storage' | 'now' | 'promptDelayMs' | 'onError'
        >
    >;
    /** Called with a path a clicked notification asks to open (default: an Inertia visit). */
    onOpen?: (path: string) => void;
};

export function NotificationsHost({
    initialPage,
    children,
    deps,
    onOpen,
}: NotificationsHostProps) {
    const [view, setView] = useState(() => ({
        identity: identityOf(initialPage),
        pushKey: pushKeyOf(initialPage),
        path: initialPage.url ?? '',
    }));

    useEffect(
        () =>
            router.on('navigate', (event) => {
                const page = event.detail.page as PageLike;
                const identity = identityOf(page);
                const pushKey = pushKeyOf(page);
                const path = page.url ?? '';

                setView((current) =>
                    current.identity.user?.id === identity.user?.id &&
                    current.identity.user?.isAdmin === identity.user?.isAdmin &&
                    current.identity.user?.isAgent === identity.user?.isAgent &&
                    current.identity.locale === identity.locale &&
                    current.pushKey === pushKey &&
                    current.path === path
                        ? current
                        : { identity, pushKey, path },
                );
            }),
        [],
    );

    const { identity, pushKey, path } = view;
    const translator = useTranslatorFor(identity.locale);
    const sound = useStaffRealtimeOptional()?.sound ?? null;
    const soundRef = useRef(sound);
    const openRef = useRef(onOpen);
    const depsRef = useRef(deps);

    useEffect(() => {
        soundRef.current = sound;
        openRef.current = onOpen;
        depsRef.current = deps;
    });

    const staff =
        identity.user && (identity.user.isAdmin || identity.user.isAgent)
            ? identity.user
            : null;
    const staffId = staff?.id ?? null;
    const staffAgent = staff?.isAgent ?? false;

    const controller = useMemo<NotificationsController | null>(
        () =>
            staffId === null
                ? null
                : createNotificationsController({
                      userId: staffId,
                      vapidPublicKey: pushKey,
                      isAgent: staffAgent,
                      ...depsRef.current,
                      // The server's mute wins over a device that is unmuted; a device the person muted stays muted (they own that toggle).
                      onSoundPreference: (soundOn) => {
                          const player = soundRef.current;

                          if (!soundOn && player && !player.isMuted()) {
                              player.setMuted(true);
                          }
                      },
                      onSoundToggle: (soundOn) =>
                          soundRef.current?.setMuted(!soundOn),
                      onOpen: (target) =>
                          openRef.current
                              ? openRef.current(target)
                              : router.visit(target),
                  }),
        [staffId, staffAgent, pushKey],
    );

    useEffect(() => {
        if (!controller) {
            return;
        }

        void controller.start();
        // Getters, so the page's own notifications always follow the member's current settings (previews, offers, messages, this browser off).
        setOsNotificationPolicy({
            quiet: () => isQuietNow(controller.getState().settings?.quietHours),
            preferences: () => osPreferencesOf(controller.getState()),
        });

        const recheck = (): void => {
            if (document.visibilityState === 'visible') {
                controller.refreshPermission();
            }
        };

        document.addEventListener('visibilitychange', recheck);

        return () => {
            document.removeEventListener('visibilitychange', recheck);
            resetOsNotificationPolicy();
            controller.stop();
        };
    }, [controller]);

    const onSettingsPage = path
        .split('?')[0]
        .startsWith(notificationRoutes.pages.settings);

    return (
        <NotificationsContext.Provider value={controller}>
            {children}
            {controller && (
                <NotificationPrompt
                    controller={controller}
                    t={translator.t}
                    suppressed={onSettingsPage}
                />
            )}
        </NotificationsContext.Provider>
    );
}
