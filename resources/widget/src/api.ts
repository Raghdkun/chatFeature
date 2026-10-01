import { parseDataAttrs } from './config';
import { Emitter } from './emitter';
import type { Dict } from './types';
import { isRecord, warn } from './util';
import { Widget } from './widget';

/**
 * `window.ChatFeature(command, ...args)`: the public JS API. Calls made before the loader finished (the
 * `ChatFeature.q` stub queue) are replayed in order; commands issued before the widget has mounted are queued
 * inside it. Installing twice is a no-op, so including the script twice is safe.
 */

const KEY = /^[A-Za-z0-9_-]{3,64}$/;
const KEY_IN_URL = /\/w\/([A-Za-z0-9_-]{3,64})\.js(?:[?#]|$)/;

export type ChatFeatureFn = ((
    command: unknown,
    ...args: unknown[]
) => unknown) & {
    q: unknown[];
    loaded: true;
};

export function findKey(script: HTMLScriptElement | null): string | null {
    const fromAttr = script?.dataset.widgetKey?.trim();

    if (fromAttr !== undefined && KEY.test(fromAttr)) {
        return fromAttr;
    }

    const m = KEY_IN_URL.exec(script?.src ?? '');

    return m === null ? null : m[1];
}

/** `document.currentScript` is only set while the script first runs; fall back to scanning for it. */
export function findScript(doc: Document): HTMLScriptElement | null {
    const cur = doc.currentScript;

    if (cur instanceof HTMLScriptElement) {
        return cur;
    }

    const all = [
        ...doc.querySelectorAll<HTMLScriptElement>(
            'script[data-widget-key], script[src*="/w/"]',
        ),
    ];

    return all.length > 0 ? all[all.length - 1] : null;
}

export function install(
    win: Window,
    script: HTMLScriptElement | null,
): ChatFeatureFn | null {
    const g = win as unknown as Dict;
    const existing = g.ChatFeature as unknown as
        | (ChatFeatureFn | { q?: unknown; loaded?: undefined })
        | undefined;

    if (typeof existing === 'function' && existing.loaded === true) {
        return null;
    }

    const emitter = new Emitter(win.document);
    let inst: Widget | null = null;
    let waiting: [string, unknown[]][] = [];
    const scriptKey = findKey(script);

    function ensureStarted(settings: Dict): void {
        const init = [g.ChatFeatureSettings, settings];

        if (inst !== null) {
            if (isRecord(settings)) {
                inst.mergeInit(settings);
            }

            return;
        }

        const key = [
            settings.widgetKey,
            (g.ChatFeatureSettings as Dict | undefined)?.widgetKey,
            scriptKey,
        ]
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .find((k) => KEY.test(k));

        if (key === undefined) {
            warn(
                'No widget key: add data-widget-key to the script tag or pass { widgetKey } to init.',
            );

            return;
        }

        inst = new Widget({
            key,
            win,
            emitter,
            script,
            data: parseDataAttrs(script),
            init,
        });
        const started = inst;
        void started.start();

        for (const [cmd, args] of waiting.splice(0)) {
            started.exec(cmd, args);
        }
    }

    function dispatch(command: unknown, args: unknown[]): unknown {
        try {
            switch (command) {
                case 'init':
                    ensureStarted(isRecord(args[0]) ? args[0] : {});

                    return undefined;
                case 'on':
                    return emitter.on(args[0], args[1]);
                case 'off':
                    emitter.off(args[0], args[1]);

                    return undefined;
                case 'getState':
                    return inst === null
                        ? {
                              status: 'idle',
                              open: false,
                              unread: 0,
                              ready: false,
                              panelReady: false,
                              widgetKey: scriptKey,
                              configVersion: null,
                          }
                        : inst.getState();
                case 'shutdown':
                    inst?.destroy();
                    inst = null;
                    waiting = [];

                    return undefined;
                default:
                    if (inst === null) {
                        if (waiting.length < 50) {
                            waiting.push([String(command), args]);
                        }
                    } else {
                        inst.exec(String(command), args);
                    }

                    return undefined;
            }
        } catch (e) {
            emitter.emit('error', {
                code: 'internal',
                message: String(e),
            });

            return undefined;
        }
    }

    const api = ((command: unknown, ...args: unknown[]) =>
        dispatch(command, args)) as ChatFeatureFn;
    api.q = [];
    api.loaded = true;
    g.ChatFeature = api;

    const queued = Array.isArray(existing?.q)
        ? (existing.q as ArrayLike<unknown>[])
        : [];

    for (const entry of queued) {
        if (entry !== null && typeof entry === 'object' && 'length' in entry) {
            const [command, ...args] = Array.from(entry);
            dispatch(command, args);
        }
    }

    // Auto-boot from the script tag (`/w/<key>.js` or data-widget-key) unless an `init` already did.
    if (inst === null && scriptKey !== null) {
        ensureStarted({});
    }

    return api;
}
