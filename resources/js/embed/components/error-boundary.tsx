import { Component, Fragment, type ReactNode } from 'react';
import { useSnapshot } from '@/embed/components/context';
import { AlertCircle } from '@/embed/components/icons';
import { reloadLazy } from '@/embed/components/lazy';
import { Button } from '@/embed/components/ui';

type Props = {
    children: ReactNode;
    /** Shown instead of a broken screen: a short text and "Try again" (an overlay may also offer to close itself). */
    onClose?: () => void;
    /** Changing this resets the boundary (a new phase starts from a clean slate). */
    resetKey?: string;
};

type State = {
    failed: boolean;
    attempt: number;
    /** The failure was a chunk that could not be imported: only a reload of the page can fetch it again (see `isChunkFailure`). */
    reloadNeeded: boolean;
};

/**
 * Chromium remembers a FAILED dynamic import for the life of the page: importing the same chunk again fails at once, whatever the
 * network does now (Firefox and Safari fetch it again). So "Try again" cannot recover a missing chunk in place there: the panel reloads
 * itself instead. Nothing is lost by that: the loader hands the stored visitor session back on the new handshake and the chat resumes.
 */
export function isChunkFailure(error: unknown): boolean {
    return (
        error instanceof Error &&
        /dynamically imported module|importing a module script failed|loading chunk|chunkloaderror/i.test(
            `${error.name} ${error.message}`,
        )
    );
}

/** Reloading the panel's own document (a seam for the tests: jsdom cannot navigate). */
export const panelPage = {
    reload: (): void => window.location.reload(),
};

/** What the visitor sees when a screen or a lazily loaded chunk fails: never a blank panel. */
function Failed({
    onRetry,
    onClose,
}: {
    onRetry: () => void;
    onClose?: () => void;
}) {
    const { t } = useSnapshot();

    return (
        <section
            role="alert"
            data-testid="panel-error"
            className="pne-screen flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
        >
            <AlertCircle aria-hidden="true" className="text-danger size-8" />
            <p className="text-subtle max-w-[32ch]">
                {t('embed.chat.error.screen')}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
                <Button data-testid="panel-error-retry" onClick={onRetry}>
                    {t('embed.chat.error.try_again')}
                </Button>
                {onClose === undefined ? null : (
                    <Button variant="quiet" onClick={onClose}>
                        {t('embed.chat.lightbox.close')}
                    </Button>
                )}
            </div>
        </section>
    );
}

export class PanelErrorBoundary extends Component<Props, State> {
    state: State = { failed: false, attempt: 0, reloadNeeded: false };

    static getDerivedStateFromError(error: unknown): Partial<State> {
        return { failed: true, reloadNeeded: isChunkFailure(error) };
    }

    componentDidUpdate(previous: Props): void {
        if (this.state.failed && previous.resetKey !== this.props.resetKey) {
            this.setState({ failed: false });
        }
    }

    private retry = (): void => {
        if (this.state.reloadNeeded) {
            panelPage.reload();

            return;
        }

        reloadLazy();
        this.setState((state) => ({
            failed: false,
            attempt: state.attempt + 1,
        }));
    };

    render(): ReactNode {
        if (this.state.failed) {
            return <Failed onRetry={this.retry} onClose={this.props.onClose} />;
        }

        // `attempt` remounts the subtree so a lazy component starts a fresh import
        return (
            <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
        );
    }
}
