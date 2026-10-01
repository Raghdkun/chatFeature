import { useSnapshot } from '@/embed/components/context';

/** "Powered by…" line (widget feature `poweredBy`); hidden while the keyboard is up to leave room for the composer. */
export function Footer() {
    const { config, t, viewport } = useSnapshot();

    if (
        config === null ||
        !config.features.poweredBy ||
        (viewport?.keyboardInset ?? 0) > 0
    ) {
        return null;
    }

    return (
        <footer className="text-subtle flex-none py-1.5 pb-[calc(0.375rem+var(--pne-safe-b,0px))] text-center text-[11px]">
            {t('poweredBy')}
        </footer>
    );
}
