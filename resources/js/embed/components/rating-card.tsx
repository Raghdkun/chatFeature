import { useState, type KeyboardEvent } from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { Star } from '@/embed/components/icons';
import { NoticeBanner } from '@/embed/components/notice';
import { Button, INPUT_CLASS } from '@/embed/components/ui';

const STARS = [1, 2, 3, 4, 5] as const;

/** `ended`: 1-5 stars, an optional comment (<= 2000), skippable. The transcript stays readable above it. */
export function RatingCard() {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const [score, setScore] = useState(0);
    const [comment, setComment] = useState('');
    const rtl = config?.dir === 'rtl';

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
        const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
        let next = score;

        if (event.key === forward || event.key === 'ArrowUp') {
            next = Math.min(5, Math.max(1, score + 1));
        } else if (event.key === backward || event.key === 'ArrowDown') {
            next = Math.max(1, score - 1 || 1);
        } else {
            return;
        }

        event.preventDefault();
        setScore(next);
        event.currentTarget
            .querySelector<HTMLElement>(`[data-star="${next}"]`)
            ?.focus();
    };

    return (
        <section className="pne-screen border-line bg-surface flex flex-none flex-col gap-3 border-t px-4 pt-4 pb-[calc(1rem+var(--pne-safe-b,0px))]">
            <h2
                data-screen-title
                tabIndex={-1}
                className="text-[17px] leading-snug font-semibold outline-none"
            >
                {t('ratingTitle')}
            </h2>
            <NoticeBanner />
            <div
                role="radiogroup"
                aria-label={t('ratingTitle')}
                data-testid="rating-stars"
                onKeyDown={onKeyDown}
                className="flex gap-1.5"
            >
                {STARS.map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={score === value}
                        aria-label={t('embed.chat.rating.star', {
                            count: value,
                        })}
                        data-star={value}
                        data-testid={`rating-star-${value}`}
                        tabIndex={
                            score === value || (score === 0 && value === 1)
                                ? 0
                                : -1
                        }
                        data-autofocus={value === 1 ? true : undefined}
                        onClick={() => setScore(value)}
                        className="pne-press pne-focus grid size-11 place-items-center rounded-md"
                    >
                        <Star
                            aria-hidden="true"
                            strokeWidth={1.75}
                            className={`size-7 transition-colors duration-150 ${
                                value <= score ? 'text-accent' : 'text-subtle'
                            }`}
                            fill={value <= score ? 'currentColor' : 'none'}
                        />
                    </button>
                ))}
            </div>
            <textarea
                data-testid="rating-comment"
                rows={2}
                maxLength={2000}
                value={comment}
                aria-label={t('embed.chat.rating.comment_label')}
                placeholder={t('ratingPlaceholder')}
                onChange={(event) => setComment(event.target.value)}
                className={`${INPUT_CLASS} resize-none`}
            />
            <div className="flex gap-2">
                <Button
                    data-testid="rating-submit"
                    className="flex-1"
                    disabled={score === 0}
                    busy={state.busy === 'rating'}
                    onClick={() => void controller.rate(score, comment)}
                >
                    {t('embed.chat.rating.submit')}
                </Button>
                <Button
                    variant="ghost"
                    data-testid="rating-skip"
                    disabled={state.busy === 'rating'}
                    onClick={() => controller.skipRating()}
                >
                    {t('embed.chat.rating.skip')}
                </Button>
            </div>
        </section>
    );
}
