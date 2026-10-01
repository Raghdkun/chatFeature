import { router, usePage } from '@inertiajs/react';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { useTrans } from '@/hooks/use-trans';
import {
    absoluteTime,
    healthTone,
    natsState,
    relativeTime,
    type HealthTone,
} from '@/lib/auth-settings';
import { cn } from '@/lib/utils';
import type { AuthSettingsData } from '@/types/pizzasys';

const DOT: Record<HealthTone, string> = {
    ok: 'bg-primary',
    warn: 'bg-amber-500',
    bad: 'bg-destructive',
    muted: 'bg-muted-foreground/50',
};

/** A timestamp as "5 minutes ago" with the exact time on hover; "Never" when there is none. */
export function When({
    iso,
    empty,
    locale,
}: {
    iso: string | null;
    empty: string;
    locale: string;
}) {
    const relative = relativeTime(iso, { locale });

    if (!iso || relative === null) {
        return <span className="text-muted-foreground">{empty}</span>;
    }

    return (
        <time dateTime={iso} title={absoluteTime(iso, locale) ?? iso}>
            {relative}
        </time>
    );
}

/**
 * Is the Auth Portal reachable right now? Reads `authSettings.health` (written by the auth
 * driver and the NATS consumer) and re-reads it on demand, so an admin can confirm a fix without
 * leaving the page.
 */
export function HealthCard({ health }: { health: AuthSettingsData['health'] }) {
    const { t } = useTrans();
    const { locale } = usePage().props;
    const [refreshing, setRefreshing] = useState(false);
    const tone = healthTone(health.portal);
    const nats = natsState(health.nats);

    const refresh = () => {
        router.reload({
            only: ['authSettings'],
            onStart: () => setRefreshing(true),
            onFinish: () => setRefreshing(false),
        });
    };

    return (
        <Card
            role="region"
            aria-labelledby="settings-auth-health-title"
            data-testid="settings-auth-health"
            data-status={health.portal}
        >
            <CardHeader>
                <div className="flex items-start justify-between gap-3">
                    <div className="grid gap-1.5">
                        <CardTitle
                            id="settings-auth-health-title"
                            role="heading"
                            aria-level={2}
                        >
                            {t('settings.auth.health.title')}
                        </CardTitle>
                        <CardDescription>
                            {t('settings.auth.health.description')}
                        </CardDescription>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={refresh}
                        disabled={refreshing}
                        data-testid="settings-auth-health-refresh"
                    >
                        <RefreshCw
                            className={cn(
                                refreshing &&
                                    'animate-spin motion-reduce:animate-none',
                            )}
                            aria-hidden
                        />
                        {t('settings.auth.health.refresh')}
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
                    <dt className="text-muted-foreground">
                        {t('settings.auth.health.portal')}
                    </dt>
                    <dd className="grid gap-1">
                        <Badge
                            variant="outline"
                            className="w-fit gap-2 font-medium"
                            data-testid="settings-auth-health-status"
                            data-status={health.portal}
                        >
                            <span
                                className={cn('size-2 rounded-full', DOT[tone])}
                                aria-hidden
                            />
                            {t(`settings.auth.health.status.${health.portal}`)}
                        </Badge>
                        <span className="text-muted-foreground">
                            {t(
                                `settings.auth.health.status_hint.${health.portal}`,
                            )}
                        </span>
                    </dd>

                    <dt className="text-muted-foreground">
                        {t('settings.auth.health.circuit')}
                    </dt>
                    <dd data-testid="settings-auth-health-circuit">
                        {health.circuit_open
                            ? t('settings.auth.health.circuit_open')
                            : t('settings.auth.health.circuit_closed')}
                    </dd>

                    <dt className="text-muted-foreground">
                        {t('settings.auth.health.last_verify')}
                    </dt>
                    <dd data-testid="settings-auth-health-last-verify">
                        <When
                            iso={health.last_verify_at}
                            empty={t('settings.auth.health.never')}
                            locale={locale}
                        />
                    </dd>

                    <dt className="text-muted-foreground">
                        {t('settings.auth.health.nats')}
                    </dt>
                    <dd
                        className="grid gap-1"
                        data-testid="settings-auth-health-nats"
                        data-state={nats}
                    >
                        <span>
                            {t(`settings.auth.health.nats_state.${nats}`)}
                        </span>
                        {health.nats.enabled && (
                            <span className="text-muted-foreground">
                                {t('settings.auth.health.last_event')}{' '}
                                <When
                                    iso={health.nats.last_event_at}
                                    empty={t('settings.auth.health.never')}
                                    locale={locale}
                                />
                            </span>
                        )}
                    </dd>
                </dl>
            </CardContent>
        </Card>
    );
}
