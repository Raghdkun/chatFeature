import { useSnapshot } from '@/embed/components/context';

/** `booting`: a calm skeleton while the config, categories and any stored session are loaded. */
export function BootScreen() {
    const { t, unavailable } = useSnapshot();

    if (unavailable) {
        return (
            <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[18px] font-semibold outline-none"
                >
                    {t('embed.chat.error.unavailable')}
                </h2>
            </section>
        );
    }

    return (
        <section
            aria-busy="true"
            aria-label={t('embed.chat.loading')}
            className="flex min-h-0 flex-1 flex-col gap-4 p-5"
        >
            <span className="sr-only">{t('embed.chat.loading')}</span>
            <span className="pne-skeleton block size-12 rounded-full" />
            <span className="pne-skeleton block h-6 w-3/4 rounded-md" />
            <span className="pne-skeleton block h-4 w-1/2 rounded-md" />
            <span className="pne-skeleton mt-auto block h-11 w-full rounded-md" />
        </section>
    );
}
