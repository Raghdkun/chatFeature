import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
    ControllerContext,
    EnvContext,
    OverlayContext,
    useController,
    useSnapshot,
    type Overlay,
    type PanelEnv,
} from '@/embed/components/context';
import { Footer } from '@/embed/components/footer';
import { Header } from '@/embed/components/header';
import { EndChatDialog, Lightbox } from '@/embed/components/overlays';
import { BootScreen } from '@/embed/components/screens/boot-screen';
import { CategoryScreen } from '@/embed/components/screens/category-screen';
import { ChatScreen } from '@/embed/components/screens/chat-screen';
import { ClosedScreen } from '@/embed/components/screens/closed-screen';
import { OfflineScreen } from '@/embed/components/screens/offline-screen';
import { PrechatScreen } from '@/embed/components/screens/prechat-screen';
import { QueuedScreen } from '@/embed/components/screens/queued-screen';
import { WelcomeScreen } from '@/embed/components/screens/welcome-screen';
import { resolveScheme, rootStyle } from '@/embed/config/theme';
import { usePrefersDark } from '@/embed/hooks/use-media';
import { useScreenFocus } from '@/embed/hooks/use-screen-focus';
import type { ChatController } from '@/embed/session/controller';
import type { Phase } from '@/embed/state/machine';

function Screen({ phase }: { phase: Phase }) {
    switch (phase) {
        case 'idle':
            return <WelcomeScreen />;
        case 'prechat':
            return <PrechatScreen />;
        case 'category':
            return <CategoryScreen />;
        case 'queued':
            return <QueuedScreen />;
        case 'active':
        case 'ended':
            return <ChatScreen />;
        case 'offline':
            return <OfflineScreen />;
        case 'closed':
            return <ClosedScreen />;
        default:
            return <BootScreen />;
    }
}

/** A web font the admin configured (https, an allowed host: `sanitizeTheme` already checked), loaded as a stylesheet link. */
function useFontLink(url: string | null): void {
    useEffect(() => {
        if (url === null) {
            return;
        }

        const link = document.createElement('link');

        link.rel = 'stylesheet';
        link.href = url;
        document.head.append(link);

        return () => link.remove();
    }, [url]);
}

function Panel() {
    const { state, config, viewport } = useSnapshot();
    const controller = useController();
    const root = useRef<HTMLDivElement>(null);
    const dark = usePrefersDark();
    const [overlay, setOverlay] = useState<Overlay>(null);
    const scheme = resolveScheme(config?.theme.mode ?? 'auto', dark);
    const keyboard = viewport?.keyboardInset ?? 0;

    useFontLink(config?.theme.fontUrl ?? null);
    useScreenFocus(root, state.phase, state.open);

    useEffect(() => {
        if (config === null) {
            return;
        }

        const html = document.documentElement;

        html.lang = config.textLocale;
        html.dir = config.dir;
    }, [config]);

    useEffect(() => {
        // Escape inside the iframe: the loader cannot see key events here, so the panel asks it to close. Dialogs stop the event first.
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                controller.requestClose();
            }
        };

        window.addEventListener('keydown', onKey);

        return () => window.removeEventListener('keydown', onKey);
    }, [controller]);

    const style = {
        ...(config === null ? {} : rootStyle(config, scheme)),
        '--pne-kb': `${keyboard}px`,
        '--pne-safe-b':
            keyboard > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)',
    } as CSSProperties;
    const modal = overlay !== null;

    return (
        <OverlayContext.Provider
            value={{
                overlay,
                openImage: (url, alt) =>
                    setOverlay({ type: 'image', url, alt }),
                openEnd: () => setOverlay({ type: 'end' }),
                close: () => setOverlay(null),
            }}
        >
            <div
                ref={root}
                data-testid="chat-panel"
                data-scheme={scheme}
                className="pne-root"
                dir={config?.dir}
                lang={config?.textLocale}
                style={style}
            >
                <div
                    inert={modal || undefined}
                    className="flex min-h-0 flex-1 flex-col"
                >
                    <Header onEndChat={() => setOverlay({ type: 'end' })} />
                    <main
                        data-testid="chat-state"
                        data-state={state.phase}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        <Screen key={state.phase} phase={state.phase} />
                    </main>
                    <Footer />
                </div>
                {overlay?.type === 'image' ? (
                    <Lightbox url={overlay.url} alt={overlay.alt} />
                ) : null}
                {overlay?.type === 'end' ? (
                    <EndChatDialog
                        onConfirm={() => {
                            setOverlay(null);
                            void controller.endChat();
                        }}
                    />
                ) : null}
            </div>
        </OverlayContext.Provider>
    );
}

export function App({
    controller,
    env,
}: {
    controller: ChatController;
    env: PanelEnv;
}) {
    return (
        <ControllerContext.Provider value={controller}>
            <EnvContext.Provider value={env}>
                <Panel />
            </EnvContext.Provider>
        </ControllerContext.Provider>
    );
}
