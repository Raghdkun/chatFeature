/**
 * The notification session of one signed-in staff member: framework-free logic (a store with `getState` / `subscribe`, like the
 * inbox store) that the React layer renders and tests drive with fakes.
 *
 * What it does, in order, when started (decisions P5-D7, P5-D8):
 *  1. loads the member's notification settings (and tells the sound player what the server says);
 *  2. if this browser can do web push and the server has VAPID keys:
 *     - permission already granted: registers the service worker, makes sure the browser is subscribed with the CURRENT key (a
 *       rotated key means subscribing again and dropping the old row) and that the server knows the subscription;
 *     - permission blocked: records it once so the settings page can explain;
 *     - permission not asked yet: decides whether the explainer dialog opens (`shouldPrompt`). It NEVER asks the browser by itself:
 *       only `enable()`, called from the dialog's or the settings page's button, calls `Notification.requestPermission()`.
 *  3. listens for what the service worker posts (a notification click: open that chat; a rotated subscription: check it again).
 *
 * "Turn off for this browser" is remembered per user on this device (`pne.notifications.off.{id}`) so the next page load does not
 * quietly subscribe again.
 */
import { isApiError } from '@/lib/api-client';
import {
    createNotificationsApi,
    type NotificationsApi,
} from '@/lib/notifications/api';
import {
    applicationServerKey,
    browserPushEnv,
    sameApplicationServerKey,
    type PushEnv,
} from '@/lib/notifications/browser';
import { shouldPrompt } from '@/lib/notifications/prompt';
import type {
    NotificationSettings,
    NotificationSettingsPatch,
    PermissionState,
    PushDevice,
    PushSupport,
} from '@/lib/notifications/types';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

export type NotificationsState = {
    support: PushSupport;
    /** The server has VAPID keys (the `push` shared prop was present). */
    pushConfigured: boolean;
    permission: PermissionState;
    settings: NotificationSettings | null;
    settingsStatus: SettingsStatus;
    /** The registered browsers; `null` until loaded. */
    devices: PushDevice[] | null;
    /** The sha-256 of this browser's push endpoint when it is subscribed (matches `PushDevice.endpointHash`). */
    thisDeviceHash: string | null;
    /** This browser holds a push subscription the server knows about. */
    subscribed: boolean;
    /** The person turned notifications off for this browser. */
    offHere: boolean;
    busy: null | 'enable' | 'disable' | 'test';
    promptOpen: boolean;
};

export type EnableResult =
    | 'enabled'
    | 'denied'
    | 'dismissed'
    | 'unsupported'
    | 'failed';

export type TestOutcome =
    | { kind: 'sent'; sent: number; devices: number }
    | { kind: 'failed' }
    | { kind: 'none' }
    | { kind: 'limited'; retryAfter: number | null }
    | { kind: 'unavailable' };

export type NotificationsDeps = {
    userId: number;
    /** The public VAPID key (`push.vapidPublicKey`), `null` when the server has none. */
    vapidPublicKey: string | null;
    api?: NotificationsApi;
    env?: PushEnv;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    now?: () => number;
    /** How long after start the explainer opens (so it never flashes in during the page load). */
    promptDelayMs?: number;
    /** The server's `sound` preference when the settings load, for the sound player. */
    onSoundPreference?: (soundOn: boolean) => void;
    /** The person flipped the sound switch: the player follows (both ways). */
    onSoundToggle?: (soundOn: boolean) => void;
    /** A notification was clicked in another window: show this path. */
    onOpen?: (path: string) => void;
    /** Where unexpected failures are reported. */
    onError?: (error: unknown) => void;
};

function defaultStorage(): NotificationsDeps['storage'] {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

const SAME_ORIGIN_PATH = /^\/(?!\/)[^\\\s]*$/;

/** A path the worker asks the page to open: same-origin, absolute, nothing else (a message could come from anywhere). */
export function openablePath(value: unknown): string | null {
    return typeof value === 'string' && SAME_ORIGIN_PATH.test(value)
        ? value
        : null;
}

function mergeSettings(
    settings: NotificationSettings,
    patch: NotificationSettingsPatch,
): NotificationSettings {
    return {
        ...settings,
        ...(patch.sound !== undefined ? { sound: patch.sound } : {}),
        ...(patch.pushOffers !== undefined
            ? { pushOffers: patch.pushOffers }
            : {}),
        ...(patch.pushMessages !== undefined
            ? { pushMessages: patch.pushMessages }
            : {}),
        ...(patch.includePreview !== undefined
            ? { includePreview: patch.includePreview }
            : {}),
        ...(patch.quietHours !== undefined
            ? { quietHours: { ...settings.quietHours, ...patch.quietHours } }
            : {}),
        ...(patch.promptState !== undefined
            ? { promptState: patch.promptState }
            : {}),
    };
}

export function createNotificationsController(deps: NotificationsDeps) {
    const api = deps.api ?? createNotificationsApi();
    const env = deps.env ?? browserPushEnv();
    const storage =
        deps.storage === undefined ? defaultStorage() : deps.storage;
    const now = deps.now ?? Date.now;
    const promptDelayMs = deps.promptDelayMs ?? 1_500;
    const offKey = `pne.notifications.off.${deps.userId}`;
    const keyBytes = deps.vapidPublicKey ? safeKey(deps.vapidPublicKey) : null;
    const pushConfigured = keyBytes !== null;
    const listeners = new Set<() => void>();

    let started = false;
    let stopped = false;
    let promptTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenWorker: (() => void) | null = null;
    let saveChain: Promise<unknown> = Promise.resolve();

    let state: NotificationsState = {
        support: env.support,
        pushConfigured,
        permission: env.support.supported ? env.permission() : 'unsupported',
        settings: null,
        settingsStatus: 'idle',
        devices: null,
        thisDeviceHash: null,
        subscribed: false,
        offHere: readOff(),
        busy: null,
        promptOpen: false,
    };

    function safeKey(key: string): Uint8Array<ArrayBuffer> | null {
        try {
            return applicationServerKey(key);
        } catch {
            return null;
        }
    }

    function readOff(): boolean {
        try {
            return storage?.getItem(offKey) === '1';
        } catch {
            return false;
        }
    }

    function writeOff(off: boolean): void {
        try {
            if (off) {
                storage?.setItem(offKey, '1');
            } else {
                storage?.removeItem(offKey);
            }
        } catch {
            // Private mode: the choice lasts for this page only.
        }

        set({ offHere: off });
    }

    function set(patch: Partial<NotificationsState>): void {
        if (stopped) {
            return;
        }

        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    }

    function report(error: unknown): void {
        deps.onError?.(error);
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                           */
    /* ------------------------------------------------------------------ */

    async function loadSettings(): Promise<NotificationSettings | null> {
        set({ settingsStatus: 'loading' });

        try {
            const settings = await api.settings();

            set({ settings, settingsStatus: 'ready' });
            deps.onSoundPreference?.(settings.sound);

            return settings;
        } catch (error) {
            report(error);
            set({ settingsStatus: 'error' });

            return null;
        }
    }

    /**
     * Save a change. The screen shows it at once; a rejected save puts the values from before it back. Saves run one after the
     * other, so two quick toggles cannot overtake each other; each answer replaces the settings with what the server holds.
     * Resolves whether the server accepted it.
     */
    function updateSettings(
        patch: NotificationSettingsPatch,
    ): Promise<boolean> {
        const before = state.settings;

        if (!before) {
            return Promise.resolve(false);
        }

        set({ settings: mergeSettings(before, patch) });

        const run = async (): Promise<boolean> => {
            try {
                const saved = await api.updateSettings(patch);

                set({ settings: saved });

                if (patch.sound !== undefined) {
                    deps.onSoundToggle?.(saved.sound);
                }

                return true;
            } catch (error) {
                report(error);
                set({ settings: before });

                return false;
            }
        };

        const result = saveChain.then(run, run);

        saveChain = result;

        return result;
    }

    /* ------------------------------------------------------------------ */
    /* Subscription                                                       */
    /* ------------------------------------------------------------------ */

    async function loadDevices(): Promise<PushDevice[] | null> {
        try {
            const devices = await api.devices();

            set({ devices });

            return devices;
        } catch (error) {
            report(error);

            return null;
        }
    }

    /**
     * Registers the worker, subscribes this browser with the CURRENT server key and tells the server (an upsert, which also refreshes the
     * session the row belongs to). A subscription made with an older key is dropped, together with its row on the server.
     */
    async function ensureSubscribed(): Promise<boolean> {
        if (!state.support.supported || keyBytes === null) {
            return false;
        }

        try {
            await env.registerWorker();

            let subscription = await env.currentSubscription();
            let staleHash: string | null = null;

            if (
                subscription &&
                !sameApplicationServerKey(
                    subscription.options?.applicationServerKey,
                    keyBytes,
                )
            ) {
                staleHash = await env.sha256Hex(subscription.endpoint);
                await subscription.unsubscribe();
                subscription = null;
            }

            subscription ??= await env.subscribe(keyBytes);

            const hash = await env.sha256Hex(subscription.endpoint);

            await api.register(subscription.toJSON());

            const devices = (await loadDevices()) ?? state.devices ?? [];
            const stale =
                staleHash === null
                    ? undefined
                    : devices.find(
                          (device) => device.endpointHash === staleHash,
                      );

            if (stale) {
                await api.remove(stale.id).catch(report);
                await loadDevices();
            }

            set({ thisDeviceHash: hash, subscribed: true });

            return true;
        } catch (error) {
            report(error);
            set({ subscribed: false });

            return false;
        }
    }

    /** Take this browser's subscription down (browser and server). */
    async function dropSubscription(): Promise<void> {
        try {
            const subscription = await env.currentSubscription();

            if (subscription) {
                const hash = await env.sha256Hex(subscription.endpoint);
                const devices = state.devices ?? (await loadDevices()) ?? [];
                const row = devices.find(
                    (device) => device.endpointHash === hash,
                );

                if (row) {
                    await api.remove(row.id).catch(report);
                }

                await subscription.unsubscribe();
            }
        } catch (error) {
            report(error);
        }

        await loadDevices();
        set({ subscribed: false, thisDeviceHash: null });
    }

    /* ------------------------------------------------------------------ */
    /* Prompt                                                             */
    /* ------------------------------------------------------------------ */

    function promptWanted(): boolean {
        return shouldPrompt({
            support: state.support,
            pushConfigured,
            permission: state.permission,
            settings: state.settings,
            nowMs: now(),
            offHere: state.offHere,
        });
    }

    function schedulePrompt(): void {
        if (promptTimer !== null || !promptWanted()) {
            return;
        }

        promptTimer = setTimeout(() => {
            promptTimer = null;

            if (promptWanted()) {
                set({ promptOpen: true });
            }
        }, promptDelayMs);
    }

    function clearPromptTimer(): void {
        if (promptTimer !== null) {
            clearTimeout(promptTimer);
            promptTimer = null;
        }
    }

    /** "Not now": hide the dialog and ask again after the snooze (the server computes the deadline). */
    async function snooze(): Promise<void> {
        clearPromptTimer();
        set({ promptOpen: false });
        await updateSettings({ promptState: 'snoozed' });
    }

    /** The dialog went away without a choice being recorded (the page navigated, say): it may open again on the next start. */
    function closePrompt(): void {
        clearPromptTimer();
        set({ promptOpen: false });
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * The button was pressed: now, and only now, the browser is asked for permission. `granted` subscribes and registers this browser;
     * a refusal is recorded (`denied`), and a prompt closed without an answer counts as "not now".
     */
    async function enable(): Promise<EnableResult> {
        if (!state.support.supported || !pushConfigured) {
            return 'unsupported';
        }

        clearPromptTimer();
        set({ busy: 'enable' });

        try {
            const permission = await env.requestPermission();

            set({ permission });

            if (permission === 'granted') {
                writeOff(false);

                if (!(await ensureSubscribed())) {
                    return 'failed';
                }

                await updateSettings({ promptState: 'granted' });

                return 'enabled';
            }

            if (permission === 'denied') {
                await updateSettings({ promptState: 'denied' });

                return 'denied';
            }

            await updateSettings({ promptState: 'snoozed' });

            return 'dismissed';
        } catch (error) {
            report(error);

            return 'failed';
        } finally {
            set({ busy: null, promptOpen: false });
        }
    }

    /** "Turn off for this browser": unsubscribes it and remembers the choice on this device. */
    async function disable(): Promise<void> {
        set({ busy: 'disable' });

        try {
            writeOff(true);
            await dropSubscription();
        } finally {
            set({ busy: null });
        }
    }

    /** Remove one registered browser; if it is this one, it is also unsubscribed here and stays off. */
    async function removeDevice(id: string): Promise<boolean> {
        const device = state.devices?.find((entry) => entry.id === id);

        try {
            await api.remove(id);
        } catch (error) {
            report(error);

            return false;
        }

        if (device && device.endpointHash === state.thisDeviceHash) {
            writeOff(true);

            try {
                await (await env.currentSubscription())?.unsubscribe();
            } catch (error) {
                report(error);
            }

            set({ subscribed: false, thisDeviceHash: null });
        }

        await loadDevices();

        return true;
    }

    /** "Send a test notification": a real push to this person's browsers, answered by what the push services did. */
    async function sendTest(): Promise<TestOutcome> {
        set({ busy: 'test' });

        try {
            const result = await api.test();

            return result.sent > 0
                ? { kind: 'sent', sent: result.sent, devices: result.devices }
                : { kind: 'failed' };
        } catch (error) {
            if (isApiError(error)) {
                if (error.code === 'no_push_devices') {
                    return { kind: 'none' };
                }

                if (error.code === 'rate_limited') {
                    return { kind: 'limited', retryAfter: error.retryAfter };
                }

                if (error.code === 'push_unavailable') {
                    return { kind: 'unavailable' };
                }
            }

            report(error);

            return { kind: 'failed' };
        } finally {
            set({ busy: null });
            void loadDevices();
        }
    }

    /** Re-read the browser's permission (the person may have changed it in the site settings while this page was open). */
    function refreshPermission(): void {
        if (state.support.supported) {
            set({ permission: env.permission() });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    function onWorkerMessage(data: unknown): void {
        if (typeof data !== 'object' || data === null) {
            return;
        }

        const message = data as { type?: unknown; url?: unknown };

        if (message.type === 'pne:open') {
            const path = openablePath(message.url);

            if (path !== null) {
                deps.onOpen?.(path);
            }
        } else if (message.type === 'pne:subscription-changed') {
            if (state.permission === 'granted' && !state.offHere) {
                void ensureSubscribed();
            }
        }
    }

    async function start(): Promise<void> {
        if (started) {
            return;
        }

        started = true;

        if (state.support.supported) {
            unlistenWorker = env.onWorkerMessage(onWorkerMessage);
        }

        const settings = await loadSettings();

        if (
            !settings ||
            stopped ||
            !pushConfigured ||
            !settings.pushAvailable
        ) {
            return;
        }

        // The device list belongs to the account, not to this browser: a phone that cannot do push still shows (and removes) the desktop's.
        if (!state.support.supported) {
            void loadDevices();

            return;
        }

        refreshPermission();

        if (state.permission === 'granted') {
            if (!state.offHere) {
                await ensureSubscribed();
            } else {
                void loadDevices();
            }

            if (settings.promptState !== 'granted') {
                await updateSettings({ promptState: 'granted' });
            }
        } else if (state.permission === 'denied') {
            void loadDevices();

            if (settings.promptState !== 'denied') {
                await updateSettings({ promptState: 'denied' });
            }
        } else {
            void loadDevices();
            schedulePrompt();
        }
    }

    function stop(): void {
        stopped = true;
        clearPromptTimer();
        unlistenWorker?.();
        unlistenWorker = null;
        listeners.clear();
    }

    return {
        getState: (): NotificationsState => state,
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        start,
        stop,
        loadSettings,
        loadDevices,
        updateSettings,
        enable,
        disable,
        removeDevice,
        sendTest,
        snooze,
        closePrompt,
        refreshPermission,
    };
}

export type NotificationsController = ReturnType<
    typeof createNotificationsController
>;
