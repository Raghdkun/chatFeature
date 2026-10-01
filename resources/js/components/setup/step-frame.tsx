import type { ReactNode } from 'react';
import type { SetupStepKey } from '@/types/setup';

/**
 * One wizard step: heading, body and an optional action footer. Remounted per step
 * (the page keys it by step), which plays the short enter transition; reduced-motion
 * users get none.
 */
export function StepFrame({
    step,
    title,
    description,
    footer,
    children,
}: {
    step: SetupStepKey;
    title: string;
    description?: string;
    footer?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section
            data-testid={`setup-step-${step}`}
            data-step={step}
            aria-labelledby={`setup-${step}-title`}
            className="flex flex-1 flex-col motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-out-quart motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
        >
            <header className="px-6 pt-6 sm:px-8 sm:pt-8">
                <h1
                    id={`setup-${step}-title`}
                    tabIndex={-1}
                    className="text-xl font-semibold tracking-tight text-balance outline-none"
                >
                    {title}
                </h1>
                {description && (
                    <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
                        {description}
                    </p>
                )}
            </header>

            <div className="flex-1 px-6 py-6 sm:px-8">{children}</div>

            {footer && (
                <footer className="flex flex-col-reverse gap-2 border-t bg-muted/40 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
                    {footer}
                </footer>
            )}
        </section>
    );
}
