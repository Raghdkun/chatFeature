/**
 * Entry of the chat panel that runs inside the widget iframe (`/embed/{key}`), the hosted page (`/c/{key}`) and the inline iframe.
 *
 * Wiring only: read the boot data the Blade shell inlined, build the controller, then either
 *  - talk to the loader over postMessage (launcher mode: `HostChannel` checks source and origin, the loader keeps the visitor
 *    token), or
 *  - boot on its own (hosted page, direct visit, inline iframe: no loader exists), with the session in this page's storage.
 * The builder preview (`?preview=1`) swaps in a canned backend so the visitor API is never called.
 * `react` is the only big dependency loaded up front; Echo / Pusher arrive when a chat enters the queue.
 */
import '@/embed/embed.css';
import { createRoot } from 'react-dom/client';
import { App } from '@/embed/components/app';
import { readEmbedBoot, type EmbedBoot } from '@/embed/boot';
import { originOf } from '@/embed/protocol/origin';
import { HostChannel } from '@/embed/protocol/host-channel';
import { armSound, sound } from '@/embed/lib/sound';
import { trackViewport } from '@/embed/lib/viewport';
import {
    ChatController,
    type ControllerDeps,
    type StoredSession,
} from '@/embed/session/controller';
import { loadStoredSession, saveStoredSession } from '@/embed/session/storage';
import { createVisitorApi } from '@/lib/chat-api/visitor';
import type { SocketFactory } from '@/lib/realtime/visitor/types';

/** Echo and Pusher are only fetched when a chat actually needs a socket. */
const lazySocket: SocketFactory = async (input) =>
    (await import('@/lib/realtime/visitor/echo-socket')).createEchoSocket(
        input,
    );

async function start(boot: EmbedBoot, container: HTMLElement): Promise<void> {
    const channel = new HostChannel({
        win: window,
        appOrigin: boot.appOrigin,
        allowedHosts: boot.allowedHosts,
        preview: boot.preview,
        hintOrigins: [
            originOf(document.referrer),
            window.location.ancestorOrigins?.[0],
        ],
        onMessage: (message) => controller.handleHostMessage(message),
    });
    // A loader exists only when this page is framed by it; a direct visit or the hosted page boots itself.
    const withHost = boot.mode === 'launcher' && channel.hasParent;
    const mode = withHost
        ? 'launcher'
        : boot.mode === 'inline'
          ? 'inline'
          : 'hosted';
    const demo = boot.preview
        ? (await import('@/embed/preview/demo')).createDemoBackend()
        : null;

    document.documentElement.dataset.mode = mode;

    const persistSession = (session: StoredSession | null): void => {
        if (boot.preview) {
            // A demo token must never reach the dashboard origin's storage through the loader.
            return;
        }

        if (withHost) {
            channel.send({ type: 'session', payload: session });
        } else {
            saveStoredSession(boot.key, session);
        }
    };
    const deps: ControllerDeps = {
        host: { send: (message) => channel.send(message) },
        persistSession,
        socketFactory: demo?.socketFactory ?? lazySocket,
        createApi: demo ? () => demo.api : undefined,
        sound: { ping: sound.ping },
        preview: boot.preview,
        // Standalone: the page fetches the public config itself, so that copy is already the fresh one.
        bootIsFresh: !withHost,
    };
    const controller = new ChatController(deps);

    controller.attachPageLifecycle(window);

    armSound();
    createRoot(container).render(
        <App
            controller={controller}
            env={{ mode, preview: boot.preview, hasHost: withHost }}
        />,
    );

    if (withHost) {
        channel.start();

        return;
    }

    // Standalone: fetch the config ourselves, restore a stored session, and consider the panel open.
    trackViewport(window, (viewport) =>
        controller.handleHostMessage({ type: 'viewport', payload: viewport }),
    );

    try {
        const api = createVisitorApi({
            base: `${boot.appOrigin}/api/v1/public`,
            widgetKey: boot.key,
            token: () => null,
        });
        const languages =
            navigator.languages?.length > 0
                ? navigator.languages
                : [navigator.language];
        const config = await api.getConfig(languages[0]);
        const stored = loadStoredSession(boot.key);

        await controller.handleInit({
            boot: config,
            overrides: {},
            ...(stored === null ? {} : { visitorSession: stored }),
            page: {
                url: (mode === 'inline'
                    ? document.referrer
                    : window.location.href
                ).slice(0, 2000),
                title: document.title.slice(0, 300),
                referrer: document.referrer.slice(0, 2000),
            },
            embedMode: 'launcher',
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                keyboardInset: 0,
            },
        });
        controller.handleHostMessage({ type: 'open' });
    } catch {
        controller.fail();
    }
}

const boot = readEmbedBoot(window.__PNE_EMBED__);
const container = document.getElementById('chat-root');

if (boot !== null && container !== null) {
    void start(boot, container);
}
