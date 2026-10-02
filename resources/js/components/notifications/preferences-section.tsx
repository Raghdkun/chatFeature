import { toast } from 'sonner';
import { SectionCard, SwitchRow } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import type { NotificationsController } from '@/lib/notifications/controller';
import type {
    NotificationSettings,
    NotificationSettingsPatch,
} from '@/lib/notifications/types';

/** The four switches: sound, push for chat requests, push for messages, and whether a push carries the visitor's words. */
export function PreferencesSection({
    controller,
    settings,
}: {
    controller: NotificationsController;
    settings: NotificationSettings;
}) {
    const { t } = useTrans();

    const save = async (patch: NotificationSettingsPatch): Promise<void> => {
        if (!(await controller.updateSettings(patch))) {
            toast.error(t('notifications.settings.save_failed'));
        }
    };

    return (
        <SectionCard
            title={t('notifications.prefs.title')}
            description={t('notifications.prefs.description')}
            testId="notifications-prefs"
        >
            <SwitchRow
                id="notifications-sound"
                label={t('notifications.prefs.sound')}
                description={t('notifications.prefs.sound_hint')}
                checked={settings.sound}
                onCheckedChange={(sound) => void save({ sound })}
                testId="notifications-sound"
            />
            <SwitchRow
                id="notifications-offers"
                label={t('notifications.prefs.offers')}
                description={t('notifications.prefs.offers_hint')}
                checked={settings.pushOffers}
                onCheckedChange={(pushOffers) => void save({ pushOffers })}
                testId="notifications-offers"
            />
            <SwitchRow
                id="notifications-messages"
                label={t('notifications.prefs.messages')}
                description={t('notifications.prefs.messages_hint')}
                checked={settings.pushMessages}
                onCheckedChange={(pushMessages) => void save({ pushMessages })}
                testId="notifications-messages"
            />
            <SwitchRow
                id="notifications-preview"
                label={t('notifications.prefs.preview')}
                description={
                    settings.previewsAllowed
                        ? t('notifications.prefs.preview_hint')
                        : t('notifications.prefs.preview_locked')
                }
                checked={settings.includePreview && settings.previewsAllowed}
                disabled={!settings.previewsAllowed}
                onCheckedChange={(includePreview) =>
                    void save({ includePreview })
                }
                testId="notifications-preview"
            />
        </SectionCard>
    );
}
