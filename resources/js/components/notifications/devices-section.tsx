import { Laptop, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import type { NotificationsController } from '@/lib/notifications/controller';
import type { PushDevice } from '@/lib/notifications/types';

/** The browsers registered for push, with a remove button each; this browser is marked. */
export function DevicesSection({
    controller,
    devices,
    thisDeviceHash,
    locale,
}: {
    controller: NotificationsController;
    devices: PushDevice[] | null;
    thisDeviceHash: string | null;
    locale: string;
}) {
    const { t } = useTrans();
    const format = (iso: string): string => {
        try {
            return new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
            }).format(new Date(iso));
        } catch {
            return iso;
        }
    };

    const remove = async (device: PushDevice): Promise<void> => {
        if (await controller.removeDevice(device.id)) {
            toast.success(t('notifications.devices.removed'));
        } else {
            toast.error(t('notifications.devices.remove_failed'));
        }
    };

    return (
        <SectionCard
            title={t('notifications.devices.title')}
            description={t('notifications.devices.description')}
            testId="notifications-devices"
        >
            {devices === null ? null : devices.length === 0 ? (
                <p
                    className="text-sm text-muted-foreground"
                    data-testid="notifications-devices-empty"
                >
                    {t('notifications.devices.empty')}
                </p>
            ) : (
                <ul
                    className="grid gap-3"
                    aria-label={t('notifications.devices.title')}
                >
                    {devices.map((device) => {
                        const here = device.endpointHash === thisDeviceHash;

                        return (
                            <li
                                key={device.id}
                                data-testid="notifications-device"
                                className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                            >
                                <Laptop
                                    className="size-5 shrink-0 text-muted-foreground"
                                    aria-hidden
                                />
                                <div className="grid min-w-0 flex-1 gap-0.5">
                                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                        <span className="truncate">
                                            {device.label}
                                        </span>
                                        {here && (
                                            <Badge variant="secondary">
                                                {t(
                                                    'notifications.devices.this',
                                                )}
                                            </Badge>
                                        )}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {device.createdAt
                                            ? t('notifications.devices.added', {
                                                  date: format(
                                                      device.createdAt,
                                                  ),
                                              })
                                            : null}
                                        {' · '}
                                        {device.lastUsedAt
                                            ? t(
                                                  'notifications.devices.last_used',
                                                  {
                                                      date: format(
                                                          device.lastUsedAt,
                                                      ),
                                                  },
                                              )
                                            : t(
                                                  'notifications.devices.never_used',
                                              )}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    data-testid="notifications-device-remove"
                                    aria-label={t(
                                        'notifications.devices.remove_label',
                                        { name: device.label },
                                    )}
                                    title={t('notifications.devices.remove')}
                                    onClick={() => void remove(device)}
                                >
                                    <Trash2 className="size-4" aria-hidden />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </SectionCard>
    );
}
