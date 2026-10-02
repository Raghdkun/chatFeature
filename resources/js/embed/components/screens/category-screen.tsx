import { CategoryIcon } from '@/embed/components/category-icon';
import { useController, useSnapshot } from '@/embed/components/context';
import { ChevronRight } from '@/embed/components/icons';
import { NoticeBanner } from '@/embed/components/notice';
import { Button } from '@/embed/components/ui';
import { categoryOnline } from '@/embed/config/panel-config';

/** `category`: the widget's topics as cards (skipped when there is one). Offline topics lead to the leave-a-message form. */
export function CategoryScreen() {
    const { state, config, t } = useSnapshot();
    const controller = useController();

    if (config === null) {
        return null;
    }

    const busy = state.busy === 'starting' || state.busy === 'whatsapp';
    const chosen = state.category;
    // A topic picked for WhatsApp does not depend on an agent being online: the online / offline markers would only mislead.
    const anyOffline =
        state.channel !== 'whatsapp' &&
        config.categories.some(
            (category) => !categoryOnline(config, category.slug),
        );

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <div className="flex flex-col gap-1">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[20px] leading-snug font-semibold outline-none"
                >
                    {t('categoryPrompt')}
                </h2>
            </div>
            <NoticeBanner />
            {state.fieldErrors.category ? (
                <p className="text-danger text-[13px]" role="alert">
                    {state.fieldErrors.category}
                </p>
            ) : null}
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {config.categories.map((category, index) => {
                    const online = categoryOnline(config, category.slug);
                    const picked = busy && chosen === category.slug;

                    return (
                        <li key={category.slug}>
                            <button
                                type="button"
                                data-testid={`category-option-${category.slug}`}
                                data-autofocus={index === 0 ? true : undefined}
                                disabled={busy}
                                aria-busy={picked || undefined}
                                onClick={() =>
                                    controller.chooseCategory(category.slug)
                                }
                                className="pne-press pne-focus pne-hover-lift border-line bg-surface flex w-full items-center gap-3 rounded-md border p-3 text-start disabled:opacity-60"
                            >
                                <CategoryIcon category={category} />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="text-[15px] font-semibold">
                                        {category.label}
                                    </span>
                                    {category.description ? (
                                        <span className="text-subtle text-[13px] leading-snug">
                                            {category.description}
                                        </span>
                                    ) : null}
                                    {anyOffline ? (
                                        <span className="text-subtle mt-1 inline-flex items-center gap-1.5 text-[12px]">
                                            <span
                                                aria-hidden="true"
                                                className={`size-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-line'}`}
                                            />
                                            {online
                                                ? t(
                                                      'embed.chat.category.online',
                                                  )
                                                : t(
                                                      'embed.chat.category.offline',
                                                  )}
                                        </span>
                                    ) : null}
                                </span>
                                {picked ? (
                                    <span
                                        className="pne-spinner"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <ChevronRight
                                        aria-hidden="true"
                                        className="text-subtle size-4 shrink-0 rtl:-scale-x-100"
                                    />
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
            {state.flow.preChat || state.flow.whatsapp ? (
                <Button
                    variant="ghost"
                    className="self-start"
                    data-testid="category-back"
                    disabled={busy}
                    onClick={() => controller.back()}
                >
                    {t('embed.chat.back')}
                </Button>
            ) : null}
        </section>
    );
}
