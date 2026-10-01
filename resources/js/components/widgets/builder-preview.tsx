/**
 * The builder's live preview: a mock host page in a device frame (desktop / tablet / phone,
 * LTR / RTL, light / dark) with two views of the same unsaved draft.
 *
 * - **Live**: the real loader runs inside an `<iframe srcdoc>` host page with a boot config built
 *   from the draft; the draft is pushed to the chat iframe with `draft` postMessages through the
 *   relay in `preview-host.ts`. Needs the backend routes + the built loader; when either is
 *   missing the view says so and the approximation takes over.
 * - **Approximation**: `StaticPreview`, pure React/CSS, always available.
 */
import {
    Monitor,
    RefreshCw,
    Smartphone,
    Sun,
    Moon,
    Tablet,
    MessageCircle,
    Play,
} from 'lucide-react';
import {
    useEffect,
    useId,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from 'react';
import type { GreetingDraft } from '@/components/widgets/builder-state';
import {
    Notice,
    SegmentedChoice,
    SwitchRow,
    type ChoiceOption,
} from '@/components/widgets/form-bits';
import { buildPreviewHostDocument } from '@/components/widgets/preview-host';
import {
    buildCommandMessage,
    buildDraftMessage,
    parseHostStatus,
    withPreviewScheme,
    type HostStatus,
    type PreviewScheme,
} from '@/components/widgets/preview-protocol';
import {
    DEVICES,
    StaticPreview,
    type DeviceId,
    type GreetingFocus,
} from '@/components/widgets/preview-static';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { directionFor } from '@/lib/i18n';
import { buildPreviewBoot } from '@/lib/widget-config';
import { widgetsRoutes } from '@/lib/widgets-routes';
import { cn } from '@/lib/utils';
import type { WidgetConfigData, WidgetPreviewData } from '@/types/widgets';

type View = 'live' | 'static';
type Availability = 'checking' | 'available' | 'unavailable';

export type BuilderPreviewProps = {
    widgetKey: string;
    configVersion: number;
    config: WidgetConfigData;
    greetings: GreetingDraft[];
    categories: { slug: string; label: string }[];
    preview: WidgetPreviewData;
    greetingFocus: GreetingFocus;
};

/** How long a change to something only the boot config carries (greetings, categories) waits before the host reloads. */
const REBOOT_DELAY_MS = 900;
const DRAFT_DEBOUNCE_MS = 120;

function loaderUrl(): string {
    return new URL(
        widgetsRoutes.public.loader(),
        window.location.origin,
    ).toString();
}

export function BuilderPreview({
    widgetKey,
    configVersion,
    config,
    greetings,
    categories,
    preview,
    greetingFocus,
}: BuilderPreviewProps) {
    const { t } = useTrans();
    const uid = useId();
    const [device, setDevice] = useState<DeviceId>('desktop');
    const [dir, setDir] = useState<'ltr' | 'rtl'>(
        directionFor(config.defaultLocale),
    );
    const [scheme, setScheme] = useState<PreviewScheme>(
        config.theme.mode === 'dark' ? 'dark' : 'light',
    );
    const [chosenView, setChosenView] = useState<View | null>(null);
    const [availability, setAvailability] = useState<Availability>('checking');
    const [panelOpen, setPanelOpen] = useState(false);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [seenFocus, setSeenFocus] = useState(greetingFocus.nonce);
    const [replay, setReplay] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const frameKey = `${reloadNonce}-${dir}-${scheme}`;
    // A status belongs to one frame instance: a reload / direction / scheme change starts afresh.
    const [reported, setReported] = useState<{
        key: string;
        status: HostStatus;
    } | null>(null);
    const liveStatus = reported?.key === frameKey ? reported.status : null;

    // "Preview this greeting" in the editor brings the approximation (the only view that can show it).
    if (greetingFocus.nonce !== seenFocus) {
        setSeenFocus(greetingFocus.nonce);
        setChosenView('static');
    }

    useEffect(() => {
        const controller = new AbortController();

        fetch(loaderUrl(), {
            method: 'HEAD',
            credentials: 'omit',
            signal: controller.signal,
        })
            .then((response) =>
                setAvailability(response.ok ? 'available' : 'unavailable'),
            )
            .catch((error: unknown) => {
                if (
                    !(
                        error instanceof DOMException &&
                        error.name === 'AbortError'
                    )
                ) {
                    setAvailability('unavailable');
                }
            });

        return () => controller.abort();
    }, []);

    const view: View =
        chosenView ?? (availability === 'available' ? 'live' : 'static');
    const viewOptions: ChoiceOption<View>[] = [
        {
            value: 'live',
            label: t('builder.preview.view_live'),
            icon: (
                <span
                    aria-hidden
                    className={cn(
                        'size-2 rounded-full',
                        availability === 'available'
                            ? 'bg-emerald-500'
                            : availability === 'checking'
                              ? 'animate-pulse bg-amber-400'
                              : 'bg-muted-foreground/40',
                    )}
                />
            ),
        },
        { value: 'static', label: t('builder.preview.view_static') },
    ];
    const viewport = DEVICES[device];
    const previewConfig = withPreviewScheme(config, scheme);

    return (
        <section
            aria-label={t('builder.preview.title')}
            data-testid="builder-preview"
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="text-sm font-semibold tracking-tight">
                    {t('builder.preview.title')}
                </h2>
                {availability === 'unavailable' ? (
                    <span
                        data-testid="builder-preview-view-static-only"
                        className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                    >
                        {t('builder.preview.view_static')}
                    </span>
                ) : (
                    <SegmentedChoice<View>
                        legend={t('builder.preview.view')}
                        hideLegend
                        name={`${uid}-view`}
                        value={view}
                        onChange={setChosenView}
                        options={viewOptions}
                        variant="segmented"
                        testId="builder-preview-view"
                    />
                )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SegmentedChoice<DeviceId>
                    legend={t('builder.preview.device')}
                    hideLegend
                    name={`${uid}-device`}
                    value={device}
                    onChange={setDevice}
                    options={[
                        {
                            value: 'desktop',
                            label: t('builder.preview.device_desktop'),
                            icon: <Monitor className="size-4" aria-hidden />,
                        },
                        {
                            value: 'tablet',
                            label: t('builder.preview.device_tablet'),
                            icon: <Tablet className="size-4" aria-hidden />,
                        },
                        {
                            value: 'phone',
                            label: t('builder.preview.device_phone'),
                            icon: <Smartphone className="size-4" aria-hidden />,
                        },
                    ]}
                    variant="segmented"
                    testId="builder-preview-device"
                />
                <SegmentedChoice<'ltr' | 'rtl'>
                    legend={t('builder.preview.direction')}
                    hideLegend
                    name={`${uid}-dir`}
                    value={dir}
                    onChange={setDir}
                    options={[
                        { value: 'ltr', label: 'LTR' },
                        { value: 'rtl', label: 'RTL' },
                    ]}
                    variant="segmented"
                    testId="builder-preview-dir"
                />
                <SegmentedChoice<PreviewScheme>
                    legend={t('builder.preview.scheme')}
                    hideLegend
                    name={`${uid}-scheme`}
                    value={scheme}
                    onChange={setScheme}
                    options={[
                        {
                            value: 'light',
                            label: t('builder.preview.scheme_light'),
                            icon: <Sun className="size-4" aria-hidden />,
                        },
                        {
                            value: 'dark',
                            label: t('builder.preview.scheme_dark'),
                            icon: <Moon className="size-4" aria-hidden />,
                        },
                    ]}
                    variant="segmented"
                    testId="builder-preview-scheme"
                />
            </div>

            {availability === 'unavailable' && (
                <Notice data-testid="builder-preview-unavailable">
                    <p className="font-medium">
                        {t('builder.preview.unavailable_title')}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                        {t('builder.preview.unavailable_body')}
                    </p>
                </Notice>
            )}

            <div className="min-w-0 rounded-xl border bg-muted/40 p-2.5 sm:p-3">
                <DeviceFrame width={viewport.width} height={viewport.height}>
                    {view === 'live' ? (
                        <LivePreview
                            key={frameKey}
                            widgetKey={widgetKey}
                            configVersion={configVersion}
                            config={previewConfig}
                            greetings={greetings}
                            categories={categories}
                            preview={preview}
                            dir={dir}
                            scheme={scheme}
                            device={device}
                            frameRef={frameRef}
                            status={liveStatus}
                            onStatus={(status) =>
                                setReported({ key: frameKey, status })
                            }
                        />
                    ) : (
                        <StaticPreview
                            config={previewConfig}
                            greetings={greetings}
                            scheme={scheme}
                            dir={dir}
                            device={device}
                            categories={categories}
                            focus={{
                                id: greetingFocus.id,
                                nonce: greetingFocus.nonce * 1000 + replay,
                            }}
                            panelOpen={panelOpen}
                        />
                    )}
                </DeviceFrame>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                {view === 'static' ? (
                    <>
                        <SwitchRow
                            id={`${uid}-panel`}
                            label={t('builder.preview.show_panel')}
                            checked={panelOpen}
                            onCheckedChange={setPanelOpen}
                            className="items-center gap-2"
                            testId="builder-preview-panel"
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid="builder-preview-replay"
                            onClick={() => setReplay((n) => n + 1)}
                        >
                            <Play aria-hidden />
                            {t('builder.preview.replay')}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t('builder.preview.static_note')}
                        </p>
                    </>
                ) : (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid="builder-preview-reload"
                            onClick={() => setReloadNonce((n) => n + 1)}
                        >
                            <RefreshCw aria-hidden />
                            {t('builder.preview.reload')}
                        </Button>
                        <span
                            data-testid="builder-preview-status"
                            data-loader={liveStatus?.loader ?? 'loading'}
                            role="status"
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium',
                                liveStatus?.loader === 'error' &&
                                    'border-red-400 text-red-700 dark:text-red-300',
                            )}
                        >
                            <span
                                aria-hidden
                                className={cn(
                                    'size-1.5 rounded-full',
                                    liveStatus?.loader === 'ready'
                                        ? 'bg-emerald-500'
                                        : liveStatus?.loader === 'error'
                                          ? 'bg-red-500'
                                          : 'animate-pulse bg-amber-400',
                                )}
                            />
                            {liveStatus?.loader === 'ready'
                                ? t('builder.preview.status_ready')
                                : liveStatus?.loader === 'error'
                                  ? t('builder.preview.status_error')
                                  : t('builder.preview.status_loading')}
                        </span>
                        {liveStatus?.loader === 'ready' && (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                data-testid="builder-preview-open-chat"
                                onClick={() =>
                                    frameRef.current?.contentWindow?.postMessage(
                                        buildCommandMessage('open'),
                                        window.location.origin,
                                    )
                                }
                            >
                                <MessageCircle aria-hidden />
                                {t('builder.preview.open_chat')}
                            </Button>
                        )}
                    </>
                )}
            </div>
        </section>
    );
}

/** Browser-window chrome + a viewport of the device's natural size, scaled to fit the column. */
function DeviceFrame({
    width,
    height,
    children,
}: {
    width: number;
    height: number;
    children: ReactNode;
}) {
    const { t } = useTrans();
    const ref = useRef<HTMLDivElement>(null);
    const [available, setAvailable] = useState<number | null>(null);

    useEffect(() => {
        const element = ref.current;

        if (!element) {
            return;
        }

        const measure = () => setAvailable(element.clientWidth);

        measure();

        if (typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(measure);

        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    const scale = available ? Math.min(1, available / width) : 1;

    return (
        <div
            ref={ref}
            className="flex justify-center"
            style={{ direction: 'ltr' }}
        >
            <div
                data-testid="builder-preview-frame"
                data-scale={scale.toFixed(3)}
                className="overflow-hidden rounded-lg border bg-background shadow-sm"
                style={{ width: width * scale + 2 }}
            >
                <div className="flex h-7 items-center gap-1.5 border-b bg-muted/60 px-2.5">
                    <span
                        aria-hidden
                        className="size-2 rounded-full bg-muted-foreground/30"
                    />
                    <span
                        aria-hidden
                        className="size-2 rounded-full bg-muted-foreground/30"
                    />
                    <span
                        aria-hidden
                        className="size-2 rounded-full bg-muted-foreground/30"
                    />
                    <span className="ms-2 truncate rounded bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground">
                        {t('builder.preview.address')}
                    </span>
                </div>
                <div
                    className="relative overflow-hidden"
                    style={{ width: width * scale, height: height * scale }}
                >
                    <div
                        style={{
                            width,
                            height,
                            transform: `scale(${scale})`,
                            transformOrigin: 'top left',
                        }}
                    >
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** What changes the boot config only (not restylable at runtime): the greeting pool & timing, categories. */
function bootSignature(
    config: WidgetConfigData,
    greetings: GreetingDraft[],
    categories: { slug: string; label: string }[],
): string {
    return JSON.stringify([
        config.greetings,
        config.features.whatsapp,
        greetings.map(
            ({
                body,
                agent_name,
                agent_avatar_url,
                locale,
                weight,
                is_active,
            }) => [
                body,
                agent_name,
                agent_avatar_url,
                locale,
                weight,
                is_active,
            ],
        ),
        categories,
    ]);
}

function LivePreview({
    widgetKey,
    configVersion,
    config,
    greetings,
    categories,
    preview,
    dir,
    scheme,
    device,
    frameRef,
    status,
    onStatus,
}: Omit<BuilderPreviewProps, 'greetingFocus'> & {
    dir: 'ltr' | 'rtl';
    scheme: PreviewScheme;
    device: DeviceId;
    frameRef: RefObject<HTMLIFrameElement | null>;
    status: HostStatus | null;
    onStatus: (status: HostStatus) => void;
}) {
    const { t } = useTrans();
    const [loads, setLoads] = useState(0);
    const viewport = DEVICES[device];

    const signature = bootSignature(config, greetings, categories);
    const makeBoot = () =>
        buildPreviewBoot({
            key: widgetKey,
            configVersion,
            config,
            greetings: greetings.map((greeting) => ({
                ...greeting,
                id: greeting.ulid ?? greeting.clientId,
            })),
            categories,
            preview,
        });
    const [snapshot, setSnapshot] = useState(() => ({
        signature,
        boot: makeBoot(),
    }));

    // Greeting pool / categories only reach the loader through its boot config: rebuild the host
    // document (debounced) when they change. Everything else is pushed live below.
    useEffect(() => {
        if (signature === snapshot.signature) {
            return;
        }

        const timer = setTimeout(
            () => setSnapshot({ signature, boot: makeBoot() }),
            REBOOT_DELAY_MS,
        );

        return () => clearTimeout(timer);
    }, [signature]);

    const html = buildPreviewHostDocument({
        boot: snapshot.boot,
        loaderUrl: loaderUrl(),
        dir,
        scheme,
        lang: config.defaultLocale,
        siteName: t('builder.preview.site_name'),
    });

    useEffect(() => {
        function onMessage(event: MessageEvent) {
            const parsed = parseHostStatus(
                event,
                frameRef.current?.contentWindow,
                window.location.origin,
            );

            if (parsed) {
                onStatus(parsed);
            }
        }

        window.addEventListener('message', onMessage);

        return () => window.removeEventListener('message', onMessage);
    }, [frameRef, onStatus]);

    const draftJson = JSON.stringify(buildDraftMessage(config, greetings));

    // Push the unsaved draft to the host's relay (-> chat iframe). Re-sent after every (re)load.
    useEffect(() => {
        if (loads === 0) {
            return;
        }

        const timer = setTimeout(() => {
            frameRef.current?.contentWindow?.postMessage(
                JSON.parse(draftJson) as unknown,
                window.location.origin,
            );
        }, DRAFT_DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [draftJson, loads, status?.loader, status?.frame]);

    return (
        <div
            className="relative"
            style={{ width: viewport.width, height: viewport.height }}
        >
            <iframe
                ref={frameRef}
                title={t('builder.preview.frame_title')}
                data-testid="builder-preview-iframe"
                srcDoc={html}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={() => setLoads((n) => n + 1)}
                style={{
                    width: viewport.width,
                    height: viewport.height,
                    border: 0,
                    display: 'block',
                }}
            />
        </div>
    );
}
