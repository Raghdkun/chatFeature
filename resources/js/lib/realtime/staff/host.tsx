/**
 * The staff session of the page, mounted ONCE above the Inertia app (`withApp` in `resources/js/app.tsx`).
 *
 * Why above the app: every dashboard page wraps itself in its own layout component, so anything inside a layout is torn down on
 * each visit. The websocket subscriptions, the timers and the live lists must survive navigation (a chat offer has to ring on the
 * dashboard page too), so the host sits outside the page tree and learns who is signed in from the Inertia `navigate` events
 * instead of `usePage()`. It renders no UI of its own.
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
import { toast } from 'sonner';
import { i18n } from '@/hooks/use-trans';
import { staffApi, staffRoutes, type StaffApi } from '@/lib/chat-api/staff';
import type { SessionRevokeReason } from '@/lib/chat/types';
import {
    StaffRealtimeContext,
    useInboxOptional,
    type StaffRealtimeContextValue,
} from '@/lib/realtime/staff/context';
import {
    createStaffController,
    type StaffEffects,
} from '@/lib/realtime/staff/controller';
import { useAttentionTitle } from '@/lib/realtime/staff/document-title';
import {
    socketsConfigured,
    type RealtimeProp,
} from '@/lib/realtime/staff/echo-config';
import {
    closeOsNotification,
    showOsNotification,
} from '@/lib/realtime/staff/os-notification';
import {
    bindSoundUnlock,
    createSoundPlayer,
    type SoundPlayer,
} from '@/lib/realtime/staff/sound';
import {
    createInboxStore,
    selectAttentionCount,
    type InboxState,
} from '@/lib/realtime/staff/store';
import { StaffRealtimeBindings } from '@/lib/realtime/staff/use-staff-realtime';

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

export type StaffIdentity = {
    user: { id: number; isAdmin: boolean; isAgent: boolean } | null;
    locale: string;
};

/** Who is signed in and in which language, from an Inertia page (`auth.user`, `locale` shared props). */
export function identityOf(page: {
    props: Record<string, unknown>;
}): StaffIdentity {
    const auth = page.props.auth as
        | {
              user?: {
                  id: number;
                  is_admin?: boolean;
                  is_agent?: boolean;
              } | null;
          }
        | undefined;
    const user = auth?.user ?? null;

    return {
        user: user
            ? {
                  id: user.id,
                  isAdmin: user.is_admin === true,
                  isAgent: user.is_agent === true,
              }
            : null,
        locale:
            typeof page.props.locale === 'string' && page.props.locale !== ''
                ? page.props.locale
                : 'en',
    };
}

function sameIdentity(a: StaffIdentity, b: StaffIdentity): boolean {
    return (
        a.locale === b.locale &&
        a.user?.id === b.user?.id &&
        a.user?.isAdmin === b.user?.isAdmin &&
        a.user?.isAgent === b.user?.isAgent
    );
}

function browserEffects(
    sound: SoundPlayer,
    signOut: (reason: SessionRevokeReason) => void,
): StaffEffects {
    return {
        playSound: (kind) => sound.play(kind),
        toast: (kind, message, options) => {
            const common = {
                id: options?.id,
                description: options?.description,
                duration: options?.duration,
                action: options?.action,
            };

            if (kind === 'error') {
                toast.error(message, common);
            } else if (kind === 'success') {
                toast.success(message, common);
            } else {
                toast(message, common);
            }
        },
        dismissToast: (id) => {
            toast.dismiss(id);
        },
        notify: (options) => {
            showOsNotification(options);
        },
        closeNotification: (tag) => closeOsNotification(tag),
        signOut,
        openConversation: (ulid) => {
            router.visit(staffRoutes.pages.conversation(ulid));
        },
    };
}

export type StaffSessionOptions = {
    user: { id: number; isAdmin: boolean; isAgent: boolean };
    translate: Translate;
    sockets: boolean;
    sound: SoundPlayer;
    api?: StaffApi;
    effects?: Partial<StaffEffects>;
    initial?: Partial<InboxState>;
};

/** Build the store, the controller and the "which chat is open" switch for one signed-in member of staff. */
export function createStaffSession(
    options: StaffSessionOptions,
): StaffRealtimeContextValue {
    const store = createInboxStore(options.initial);
    const viewer = {
        id: options.user.id,
        isAdmin: options.user.isAdmin,
        isAgent: options.user.isAgent,
    };
    let viewing: string | null = null;

    const controller = createStaffController({
        store,
        api: options.api ?? staffApi,
        viewer,
        t: options.translate,
        isViewing: (ulid) =>
            viewing === ulid && document.visibilityState === 'visible',
        effects: {
            ...browserEffects(options.sound, () => {
                toast.error(options.translate('inbox.session.ended'));
                window.setTimeout(() => {
                    // A hard navigation: the middleware chain ends the session and shows the sign-in page with its notice.
                    window.location.assign(staffRoutes.pages.dashboard());
                }, 1_200);
            }),
            ...options.effects,
        },
    });

    return {
        store,
        controller,
        sound: options.sound,
        viewer,
        sockets: options.sockets,
        setViewing: (ulid) => {
            viewing = ulid;
        },
    };
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

export type StaffRealtimeHostProps = {
    /** The first page (`withApp` hands it over); later visits arrive through the router's `navigate` event. */
    initialPage: { props: Record<string, unknown> };
    children: ReactNode;
    /** Force the websocket on / off (tests); default: on when the build has the Reverb settings. */
    sockets?: boolean;
    sound?: SoundPlayer;
    api?: StaffApi;
    effects?: Partial<StaffEffects>;
    initial?: Partial<InboxState>;
};

export function StaffRealtimeHost({
    initialPage,
    children,
    sockets = socketsConfigured(
        undefined,
        initialPage.props.realtime as RealtimeProp,
    ),
    sound: injectedSound,
    api,
    effects,
    initial,
}: StaffRealtimeHostProps) {
    const [identity, setIdentity] = useState(() => identityOf(initialPage));

    useEffect(
        () =>
            router.on('navigate', (event) => {
                const next = identityOf(event.detail.page);

                setIdentity((current) =>
                    sameIdentity(current, next) ? current : next,
                );
            }),
        [],
    );

    const translator = useTranslatorFor(identity.locale);
    const translate = useRef<Translate>(translator.t);

    useEffect(() => {
        translate.current = translator.t;
    });

    const [sound] = useState<SoundPlayer>(
        () => injectedSound ?? createSoundPlayer(),
    );
    const staff =
        identity.user && (identity.user.isAdmin || identity.user.isAgent)
            ? identity.user
            : null;
    const staffId = staff?.id ?? null;
    const staffAdmin = staff?.isAdmin ?? false;
    const staffAgent = staff?.isAgent ?? false;

    const session = useMemo(
        () =>
            staffId === null
                ? null
                : createStaffSession({
                      user: {
                          id: staffId,
                          isAdmin: staffAdmin,
                          isAgent: staffAgent,
                      },
                      translate: (key, replacements) =>
                          translate.current(key, replacements),
                      sockets,
                      sound,
                      api,
                      effects,
                      initial,
                  }),
        // The session is rebuilt only when somebody else signs in; callers pass stable doubles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [staffId, staffAdmin, staffAgent, sockets, sound],
    );

    useEffect(() => {
        if (!session) {
            return;
        }

        session.controller.start();

        if (!session.sockets) {
            session.controller.setConnection('unavailable');
        }

        const wake = (): void => {
            if (document.visibilityState === 'visible') {
                session.controller.wake();
            }
        };

        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);

        const unbindSound = bindSoundUnlock(session.sound);

        return () => {
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('online', wake);
            unbindSound();
            session.controller.stop();
        };
    }, [session]);

    return (
        <StaffRealtimeContext.Provider value={session}>
            {session && session.sockets ? (
                <StaffRealtimeBindings
                    controller={session.controller}
                    store={session.store}
                    userId={session.viewer.id}
                    isAdmin={session.viewer.isAdmin}
                />
            ) : null}
            {session ? <AttentionTitle /> : null}
            {children}
        </StaffRealtimeContext.Provider>
    );
}

/** Puts the number of waiting offers + unread messages in front of the document title. */
function AttentionTitle() {
    const count = useInboxOptional(selectAttentionCount) ?? 0;

    useAttentionTitle(count);

    return null;
}
