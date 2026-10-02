import { ChannelChooser } from '@/embed/components/channel-chooser';
import { useController, useSnapshot } from '@/embed/components/context';
import { MessageCircle } from '@/embed/components/icons';
import { NoticeBanner } from '@/embed/components/notice';
import { Button } from '@/embed/components/ui';

/** `idle`: nothing has to be asked, so the visitor only has to say they want to chat. */
export function WelcomeScreen() {
    const { state, config, t } = useSnapshot();
    const controller = useController();

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
            <span
                aria-hidden="true"
                className="bg-brand-soft text-brand grid size-12 place-items-center rounded-full"
            >
                <MessageCircle className="size-6" />
            </span>
            <div className="flex flex-col gap-1.5">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[22px] leading-snug font-semibold outline-none"
                >
                    {t('welcome')}
                </h2>
                <p className="text-subtle">{t('subtitle')}</p>
            </div>
            <NoticeBanner />
            {config?.features.whatsapp === true ? (
                // P6: the channel choice replaces the single start button ("Chat here" is that button).
                <ChannelChooser />
            ) : (
                <Button
                    data-testid="idle-start"
                    data-autofocus
                    block
                    busy={state.busy === 'starting'}
                    onClick={() => controller.start()}
                >
                    {t('embed.chat.idle.start')}
                </Button>
            )}
        </section>
    );
}
