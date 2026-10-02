/**
 * Doubles for the notification tests: a scriptable browser (`PushEnv`) and a recording API (`NotificationsApi`), plus fixtures of the
 * server's shapes. The real controller, components and api client run on top of them.
 */
import { vi, type Mock } from 'vite-plus/test';
import type { NotificationsApi } from '@/lib/notifications/api';
import { applicationServerKey } from '@/lib/notifications/browser';
import type { PushEnv, SubscriptionLike } from '@/lib/notifications/browser';
import type {
    NotificationSettings,
    PermissionState,
    PushDevice,
    PushSupport,
} from '@/lib/notifications/types';

export const VAPID_KEY =
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

export function settingsFixture(
    overrides: Partial<NotificationSettings> = {},
): NotificationSettings {
    return {
        sound: true,
        pushOffers: true,
        pushMessages: true,
        includePreview: true,
        quietHours: {
            enabled: false,
            start: '22:00',
            end: '07:00',
            timezone: 'UTC',
        },
        promptState: 'never',
        promptedAt: null,
        snoozedUntil: null,
        previewsAllowed: true,
        pushAvailable: true,
        snoozeDays: 7,
        ...overrides,
    };
}

export function deviceFixture(overrides: Partial<PushDevice> = {}): PushDevice {
    return {
        id: '01jdevice0000000000000000a',
        label: 'Chrome on macOS',
        userAgent: 'Mozilla/5.0',
        host: 'fcm.googleapis.com',
        endpointHash: 'hash-of-another-browser',
        createdAt: '2026-11-20T09:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        ...overrides,
    };
}

export type FakeSubscription = SubscriptionLike & {
    unsubscribe: Mock<() => Promise<boolean>>;
};

/** A subscription made with the server's CURRENT key unless a test says otherwise (`null` / other bytes = made with an older key). */
export function fakeSubscription(
    endpoint = 'https://fcm.googleapis.com/fcm/send/this-browser',
    key: ArrayBuffer | null = applicationServerKey(VAPID_KEY).buffer,
): FakeSubscription {
    return {
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: key },
        toJSON: () => ({
            endpoint,
            expirationTime: null,
            keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
        }),
        unsubscribe: vi.fn(async () => true),
    };
}

export type FakeEnv = PushEnv & {
    permissionState: PermissionState;
    /** What the browser's prompt answers when `requestPermission` is called. */
    promptAnswer: NotificationPermission;
    subscription: FakeSubscription | null;
    requestPermission: Mock<() => Promise<NotificationPermission>>;
    registerWorker: Mock<() => Promise<void>>;
    subscribe: Mock<PushEnv['subscribe']>;
    emit: (data: unknown) => void;
    workerListeners: number;
};

/** A browser that supports push (override `support` for one that does not). */
export function fakeEnv(
    initial: {
        support?: PushSupport;
        permission?: PermissionState;
        promptAnswer?: NotificationPermission;
        subscription?: FakeSubscription | null;
    } = {},
): FakeEnv {
    const handlers = new Set<(data: unknown) => void>();
    const env: FakeEnv = {
        support: initial.support ?? { supported: true },
        permissionState: initial.permission ?? 'default',
        promptAnswer: initial.promptAnswer ?? 'granted',
        subscription: initial.subscription ?? null,
        workerListeners: 0,
        permission: () => env.permissionState,
        requestPermission: vi.fn(async () => {
            env.permissionState = env.promptAnswer;

            return env.promptAnswer;
        }),
        registerWorker: vi.fn(async () => undefined),
        currentSubscription: async () => env.subscription,
        subscribe: vi.fn(async () => {
            env.subscription = fakeSubscription();

            return env.subscription;
        }),
        sha256Hex: async (text) => `sha256(${text})`,
        onWorkerMessage: (handler) => {
            handlers.add(handler);
            env.workerListeners++;

            return () => {
                handlers.delete(handler);
                env.workerListeners--;
            };
        },
        emit: (data) => handlers.forEach((handler) => handler(data)),
    };

    return env;
}

export type FakeNotificationsApi = {
    [K in keyof NotificationsApi]: Mock<NotificationsApi[K]>;
} & { devicesState: PushDevice[]; settingsState: NotificationSettings };

/** An in-memory server: settings and device rows that the calls change the way the real endpoints would. */
export function fakeNotificationsApi(
    initial: {
        settings?: Partial<NotificationSettings>;
        devices?: PushDevice[];
    } = {},
): FakeNotificationsApi {
    const api: FakeNotificationsApi = {
        settingsState: settingsFixture(initial.settings),
        devicesState: initial.devices ?? [],
        settings: vi.fn(async () => api.settingsState),
        updateSettings: vi.fn(async (patch) => {
            api.settingsState = {
                ...api.settingsState,
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
                    ? {
                          quietHours: {
                              ...api.settingsState.quietHours,
                              ...patch.quietHours,
                          },
                      }
                    : {}),
                ...(patch.promptState !== undefined
                    ? {
                          promptState: patch.promptState,
                          snoozedUntil:
                              patch.promptState === 'snoozed'
                                  ? '2026-11-27T09:00:00.000Z'
                                  : null,
                      }
                    : {}),
            };

            return api.settingsState;
        }),
        devices: vi.fn(async () => [...api.devicesState]),
        register: vi.fn(async (subscription) => {
            const hash = `sha256(${subscription.endpoint})`;
            const existing = api.devicesState.find(
                (device) => device.endpointHash === hash,
            );
            const row =
                existing ??
                deviceFixture({
                    id: `01jdevice${api.devicesState.length}`,
                    endpointHash: hash,
                });

            if (!existing) {
                api.devicesState = [row, ...api.devicesState];
            }

            return row;
        }),
        remove: vi.fn(async (id) => {
            api.devicesState = api.devicesState.filter(
                (device) => device.id !== id,
            );
        }),
        test: vi.fn(async () => ({
            devices: api.devicesState.length,
            sent: api.devicesState.length,
            failed: 0,
            removed: 0,
        })),
    };

    return api;
}

export function fakeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));

    return {
        data,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    };
}
