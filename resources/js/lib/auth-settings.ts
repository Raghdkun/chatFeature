/**
 * Small pure helpers behind Settings > Auth: health presentation, "when" formatting and the
 * active-environment switching rules. No React.
 */
import { canActivate } from '@/lib/pizzasys-form';
import type {
    AuthSettingsData,
    PizzasysEnvironmentData,
    PizzasysEnvKey,
    PortalHealthStatus,
} from '@/types/pizzasys';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted';

export function healthTone(status: PortalHealthStatus): HealthTone {
    switch (status) {
        case 'ok':
            return 'ok';
        case 'degraded':
            return 'warn';
        case 'down':
            return 'bad';
        default:
            return 'muted';
    }
}

export type NatsState = 'disabled' | 'connected' | 'disconnected' | 'unknown';

/** `connected: null` while enabled means nobody has heard from the consumer yet. */
export function natsState(nats: AuthSettingsData['health']['nats']): NatsState {
    if (!nats.enabled) {
        return 'disabled';
    }

    if (nats.connected === null) {
        return 'unknown';
    }

    return nats.connected ? 'connected' : 'disconnected';
}

export function otherEnvironment(key: PizzasysEnvKey): PizzasysEnvKey {
    return key === 'production' ? 'testing' : 'production';
}

export function environmentOf(
    settings: Pick<AuthSettingsData, 'environments'>,
    key: PizzasysEnvKey,
): PizzasysEnvironmentData | undefined {
    return settings.environments.find((env) => env.key === key);
}

/** The environment a switch would move to, when it is usable (configured, with a stored token). */
export function switchTarget(
    settings: Pick<AuthSettingsData, 'environments' | 'active_env'>,
): PizzasysEnvironmentData | null {
    const target = environmentOf(
        settings,
        otherEnvironment(settings.active_env),
    );

    return target && canActivate(target) ? target : null;
}

/** Credentials are enough to try a switch only when both are present and the risk is acknowledged. */
export function canSubmitSwitch({
    email,
    password,
    acknowledged,
}: {
    email: string;
    password: string;
    acknowledged: boolean;
}): boolean {
    return acknowledged && email.trim() !== '' && password !== '';
}

const SECOND = 1000;
const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
    { unit: 'day', ms: 24 * 60 * 60 * SECOND },
    { unit: 'hour', ms: 60 * 60 * SECOND },
    { unit: 'minute', ms: 60 * SECOND },
];

function safeLocale(locale: string): string {
    try {
        return Intl.getCanonicalLocales(locale.replace('_', '-'))[0] ?? 'en';
    } catch {
        return 'en';
    }
}

/** "5 minutes ago" / "now"; `null` for a missing or unparsable timestamp. */
export function relativeTime(
    iso: string | null | undefined,
    { now = Date.now(), locale = 'en' }: { now?: number; locale?: string } = {},
): string | null {
    if (!iso) {
        return null;
    }

    const time = Date.parse(iso);

    if (Number.isNaN(time)) {
        return null;
    }

    const formatter = new Intl.RelativeTimeFormat(safeLocale(locale), {
        numeric: 'auto',
    });
    const diff = time - now;
    const found = UNITS.find(({ ms }) => Math.abs(diff) >= ms);

    return found
        ? formatter.format(Math.round(diff / found.ms), found.unit)
        : formatter.format(0, 'second');
}

/** "Sep 30, 2026, 10:15 PM" in the viewer's locale; the raw value when it cannot be parsed. */
export function absoluteTime(
    iso: string | null | undefined,
    locale = 'en',
): string | null {
    if (!iso) {
        return null;
    }

    const time = Date.parse(iso);

    if (Number.isNaN(time)) {
        return iso;
    }

    return new Intl.DateTimeFormat(safeLocale(locale), {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(time);
}
