/** Below this width the panel is full screen (docs/contracts/postmessage-protocol.md, "Mobile / viewport rules"). */
export const MOBILE_QUERY = '(max-width: 479.98px)';

export interface ViewportInfo {
    width: number;
    height: number;
    keyboardInset: number;
}

/**
 * Tracks the mobile breakpoint, forwards `visualViewport` changes (iOS keyboard) and locks host scrolling
 * while the panel is full screen. All listeners are removed by `destroy`.
 */
export class Viewport {
    mobile = false;
    private mq: MediaQueryList | null = null;
    private locked = false;
    private saved: [string, string] = ['', ''];
    private frame: ReturnType<typeof setTimeout> | null = null;
    private last = '';
    private readonly onMq = (): void => {
        this.mobile = this.mq?.matches ?? false;
        this.onMode(this.mobile);
        this.schedule();
    };
    private readonly onChange = (): void => this.schedule();

    constructor(
        private readonly win: Window,
        private readonly onMode: (mobile: boolean) => void,
        private readonly onViewport: (v: ViewportInfo) => void,
    ) {
        this.mq =
            typeof win.matchMedia === 'function'
                ? win.matchMedia(MOBILE_QUERY)
                : null;
        this.mobile = this.mq?.matches ?? false;
        this.mq?.addEventListener('change', this.onMq);
        win.addEventListener('resize', this.onChange);
        win.visualViewport?.addEventListener('resize', this.onChange);
        win.visualViewport?.addEventListener('scroll', this.onChange);
    }

    snapshot(): ViewportInfo {
        const vv = this.win.visualViewport;

        return {
            width: Math.round(vv?.width ?? this.win.innerWidth),
            height: Math.round(vv?.height ?? this.win.innerHeight),
            keyboardInset: vv
                ? Math.max(
                      0,
                      Math.round(
                          this.win.innerHeight - vv.height - vv.offsetTop,
                      ),
                  )
                : 0,
        };
    }

    /** Coalesces bursts of resize/scroll events into one `viewport` message (about one per frame), skipping repeats. */
    private schedule(): void {
        this.frame ??= setTimeout(() => {
            this.frame = null;
            const v = this.snapshot();
            const key = `${v.width}x${v.height}+${v.keyboardInset}`;

            if (key !== this.last) {
                this.last = key;
                this.onViewport(v);
            }
        }, 16);
    }

    lock(): void {
        if (!this.locked) {
            const { documentElement: de, body } = this.win.document;
            this.saved = [de.style.overflow, body.style.overflow];
            de.style.setProperty('overflow', 'hidden');
            body.style.setProperty('overflow', 'hidden');
            this.locked = true;
        }
    }

    unlock(): void {
        if (this.locked) {
            const { documentElement: de, body } = this.win.document;
            de.style.overflow = this.saved[0];
            body.style.overflow = this.saved[1];
            this.locked = false;
        }
    }

    destroy(): void {
        this.unlock();
        this.mq?.removeEventListener('change', this.onMq);
        this.win.removeEventListener('resize', this.onChange);
        this.win.visualViewport?.removeEventListener('resize', this.onChange);
        this.win.visualViewport?.removeEventListener('scroll', this.onChange);

        if (this.frame !== null) {
            clearTimeout(this.frame);
            this.frame = null;
        }
    }
}
