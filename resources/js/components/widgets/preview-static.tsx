/**
 * Offline, framework-free approximation of the widget: the launcher (bubble / pill, flip to the
 * agent face), the greeting popup and a simplified chat panel, drawn from the unsaved draft with
 * plain React + CSS. It needs neither the backend nor the loader, so the builder is useful from
 * day one and the greeting design can be tuned live. It is an approximation: the loader is the
 * truth (see the Live view).
 */
import {
    CircleHelp,
    MessageCircle,
    MessageCircleMore,
    Paperclip,
    Send,
    Sparkles,
    X,
} from 'lucide-react';
import { useId, useState, type CSSProperties } from 'react';
import type { GreetingDraft } from '@/components/widgets/builder-state';
import type { PreviewScheme } from '@/components/widgets/preview-protocol';
import { useInitials } from '@/hooks/use-initials';
import { useTrans } from '@/hooks/use-trans';
import { directionFor } from '@/lib/i18n';
import {
    DEFAULT_TEXTS_EN,
    isHexColor,
    isSecureUrl,
    LAUNCHER_PIXELS,
    readableTextOn,
    resolveText,
} from '@/lib/widget-config';
import type { TextKey, WidgetConfigData } from '@/types/widgets';

export type DeviceId = 'desktop' | 'tablet' | 'phone';

/** Natural viewport sizes the previews are drawn at (and scaled down from). */
export const DEVICES: Record<DeviceId, { width: number; height: number }> = {
    desktop: { width: 1024, height: 640 },
    tablet: { width: 768, height: 880 },
    phone: { width: 375, height: 740 },
};

/** Below this viewport width the real widget goes full screen / uses a bottom sheet. */
export const COMPACT_BREAKPOINT = 480;

export type GreetingFocus = { id: string | null; nonce: number };

const SHADOWS = {
    none: 'none',
    soft: '0 6px 24px rgba(15,23,42,.18), 0 1px 3px rgba(15,23,42,.12)',
    strong: '0 14px 44px rgba(15,23,42,.38), 0 2px 6px rgba(15,23,42,.2)',
} as const;

function color(value: string, fallback: string): string {
    return isHexColor(value) ? value : fallback;
}

type Palette = {
    primary: string;
    primaryText: string;
    accent: string;
    surface: string;
    text: string;
    raised: string;
    border: string;
    muted: string;
};

/** The configured colours; dark mode derives its own surface and text (the loader does the same). */
export function paletteFor(
    theme: WidgetConfigData['theme'],
    scheme: PreviewScheme,
): Palette {
    const primary = color(theme.primary, '#0f766e');
    const primaryText = color(theme.primaryText, readableTextOn(primary));
    const accent = color(theme.accent, '#D97706');

    if (scheme === 'dark') {
        return {
            primary,
            primaryText,
            accent,
            surface: '#161b25',
            text: '#e8ebf2',
            raised: '#212938',
            border: 'rgba(255,255,255,.12)',
            muted: 'rgba(232,235,242,.62)',
        };
    }

    const surface = color(theme.surface, '#ffffff');
    const text = color(theme.text, '#0f172a');

    return {
        primary,
        primaryText,
        accent,
        surface,
        text,
        raised: 'rgba(15,23,42,.06)',
        border: 'rgba(15,23,42,.12)',
        muted: 'rgba(15,23,42,.6)',
    };
}

/** Which greeting the popup shows: the focused one, else the first usable one for the locale. */
export function pickPreviewGreeting(
    greetings: GreetingDraft[],
    focusId: string | null,
    locale: string,
): GreetingDraft | null {
    if (focusId) {
        return (
            greetings.find((greeting) => greeting.clientId === focusId) ?? null
        );
    }

    const base = locale.split('-')[0];
    const usable = greetings.filter(
        (greeting) => greeting.is_active && greeting.body.trim() !== '',
    );

    return (
        usable.find((greeting) => greeting.locale === null) ??
        usable.find(
            (greeting) =>
                greeting.locale === locale || greeting.locale === base,
        ) ??
        usable[0] ??
        null
    );
}

function AgentFace({
    url,
    name,
    size,
    accent,
    accentText,
}: {
    url: string | null;
    name: string | null;
    size: number;
    accent: string;
    accentText: string;
}) {
    const getInitials = useInitials();
    const [failed, setFailed] = useState(false);

    if (url && isSecureUrl(url) && !failed) {
        return (
            <img
                src={url}
                alt=""
                onError={() => setFailed(true)}
                style={{ width: size, height: size }}
                className="shrink-0 rounded-full object-cover"
            />
        );
    }

    return (
        <span
            aria-hidden
            style={{
                width: size,
                height: size,
                background: accent,
                color: accentText,
                fontSize: size * 0.4,
            }}
            className="flex shrink-0 items-center justify-center rounded-full font-semibold"
        >
            {name ? getInitials(name) : '•'}
        </span>
    );
}

export function StaticPreview({
    config,
    greetings,
    scheme,
    dir,
    device,
    categories,
    focus,
    panelOpen,
}: {
    config: WidgetConfigData;
    greetings: GreetingDraft[];
    scheme: PreviewScheme;
    dir: 'ltr' | 'rtl';
    device: DeviceId;
    categories: { slug: string; label: string }[];
    focus: GreetingFocus;
    panelOpen: boolean;
}) {
    const uid = useId();
    const { t } = useTrans();
    const { theme, launcher } = config;
    const viewport = DEVICES[device];
    const compact = viewport.width < COMPACT_BREAKPOINT;
    const palette = paletteFor(theme, scheme);
    const size = LAUNCHER_PIXELS[theme.launcherSize];
    const right = theme.position === 'bottom-right';
    const side = right ? 'right' : 'left';
    const locale = config.defaultLocale;
    const textDir = directionFor(locale);
    const accentText = readableTextOn(palette.accent);
    const greeting = config.greetings.enabled
        ? pickPreviewGreeting(greetings, focus.id, locale)
        : null;
    const [dismissedNonce, setDismissedNonce] = useState<number | null>(null);
    const popupVisible =
        greeting !== null && dismissedNonce !== focus.nonce && !panelOpen;
    const flipped = popupVisible && config.greetings.showAgent;
    const text = (key: TextKey) =>
        resolveText(config, locale, key) || DEFAULT_TEXTS_EN[key];
    const shadow = SHADOWS[theme.shadow];
    const radius = theme.radius;
    const root = `pne-${uid.replace(/[^a-z0-9]/gi, '')}`;
    const dark = scheme === 'dark';

    const widgetFont: CSSProperties = { fontFamily: theme.fontFamily };
    const launcherSurface: CSSProperties = {
        background: palette.primary,
        color: palette.primaryText,
        boxShadow: shadow,
        height: size,
    };

    const agentName = greeting?.agent_name ?? null;
    const avatarUrl = greeting?.agent_avatar_url ?? launcher.avatarUrl;
    const LauncherIcon =
        launcher.icon === 'help'
            ? CircleHelp
            : launcher.icon === 'sparkle'
              ? Sparkles
              : MessageCircle;

    return (
        <div
            data-testid="preview-static"
            data-device={device}
            data-scheme={scheme}
            dir={dir}
            className={root}
            style={{
                position: 'relative',
                width: viewport.width,
                height: viewport.height,
                overflow: 'hidden',
                background: dark ? '#0b1220' : '#f6f8fa',
                color: dark ? '#e5e7eb' : '#1f2937',
            }}
        >
            <style>{`
.${root} .pne-flip{transform-style:preserve-3d;transition:transform 700ms cubic-bezier(.3,1.25,.4,1)}
.${root} .pne-flip[data-flipped="true"]{transform:rotateY(180deg)}
.${root} .pne-face{grid-area:1/1;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.${root} .pne-face.back{transform:rotateY(180deg)}
@keyframes ${root}-pop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
.${root} .pne-pop{animation:${root}-pop 380ms cubic-bezier(.2,.9,.3,1) 300ms both}
@media (prefers-reduced-motion:reduce){
  .${root} .pne-flip{transition:none}
  .${root} .pne-flip[data-flipped="true"]{transform:none}
  .${root} .pne-face{backface-visibility:visible;transition:opacity 200ms}
  .${root} .pne-face.back{transform:none;opacity:0}
  .${root} .pne-flip[data-flipped="true"] .pne-face.front{opacity:0}
  .${root} .pne-flip[data-flipped="true"] .pne-face.back{opacity:1}
  .${root} .pne-pop{animation:none}
}`}</style>

            <MockSite dark={dark} compact={compact} />

            {popupVisible && greeting && (
                <div
                    key={`popup-${focus.nonce}`}
                    data-testid="preview-greeting"
                    role="status"
                    className="pne-pop"
                    style={{
                        ...widgetFont,
                        position: 'absolute',
                        zIndex: 2,
                        ...(compact
                            ? {
                                  left: 12,
                                  right: 12,
                                  bottom: theme.offsetY + size + 12,
                              }
                            : launcher.style === 'pill'
                              ? {
                                    // A pill is wider than it is tall: stack the popup above it.
                                    [side]: theme.offsetX,
                                    bottom: theme.offsetY + size + 12,
                                    width: 300,
                                }
                              : {
                                    [side]: theme.offsetX + size + 12,
                                    bottom: theme.offsetY + 2,
                                    width: 300,
                                }),
                        background: palette.surface,
                        color: palette.text,
                        border: `1px solid ${palette.border}`,
                        borderRadius: Math.max(radius, 8),
                        boxShadow: shadow === 'none' ? SHADOWS.soft : shadow,
                        padding: 14,
                        fontSize: 14,
                        lineHeight: 1.45,
                    }}
                >
                    <div
                        className="flex items-start gap-3"
                        dir={
                            greeting.locale
                                ? directionFor(greeting.locale)
                                : textDir
                        }
                    >
                        {config.greetings.showAgent && (
                            <AgentFace
                                url={avatarUrl}
                                name={agentName}
                                size={36}
                                accent={palette.accent}
                                accentText={accentText}
                            />
                        )}
                        <div className="min-w-0 flex-1">
                            {config.greetings.showAgent && agentName && (
                                <p style={{ fontWeight: 600, fontSize: 13 }}>
                                    {agentName}
                                </p>
                            )}
                            <p
                                data-testid="preview-greeting-body"
                                style={{
                                    whiteSpace: 'pre-wrap',
                                    overflowWrap: 'anywhere',
                                }}
                            >
                                {greeting.body.trim() === ''
                                    ? '…'
                                    : greeting.body}
                            </p>
                        </div>
                        <button
                            type="button"
                            aria-label={text('dismiss')}
                            onClick={() => setDismissedNonce(focus.nonce)}
                            style={{ color: palette.muted }}
                            className="-me-1 -mt-1 flex size-6 shrink-0 items-center justify-center rounded-full hover:opacity-70"
                        >
                            <X size={14} aria-hidden />
                        </button>
                    </div>
                </div>
            )}

            {panelOpen && (
                <div
                    data-testid="preview-panel"
                    style={{
                        ...widgetFont,
                        position: 'absolute',
                        zIndex: 3,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        background: palette.surface,
                        color: palette.text,
                        boxShadow: shadow === 'none' ? SHADOWS.soft : shadow,
                        border: `1px solid ${palette.border}`,
                        ...(compact
                            ? { inset: 0, borderRadius: 0 }
                            : {
                                  [side]: theme.offsetX,
                                  bottom: theme.offsetY + size + 12,
                                  width: Math.min(
                                      theme.panelWidth,
                                      viewport.width - 2 * theme.offsetX,
                                  ),
                                  height: Math.min(
                                      theme.panelHeight,
                                      viewport.height -
                                          theme.offsetY -
                                          size -
                                          24,
                                  ),
                                  borderRadius: radius,
                              }),
                    }}
                >
                    <div
                        style={{
                            background: palette.primary,
                            color: palette.primaryText,
                            padding: '14px 16px',
                        }}
                        className="flex items-center gap-3"
                        dir={textDir}
                    >
                        <div className="min-w-0 flex-1">
                            <p style={{ fontWeight: 600, fontSize: 15 }}>
                                {text('title')}
                            </p>
                            <p style={{ fontSize: 12, opacity: 0.85 }}>
                                {text('subtitle')}
                            </p>
                        </div>
                        <X size={18} aria-hidden />
                    </div>
                    <div
                        className="flex flex-1 flex-col gap-3 overflow-hidden"
                        style={{ padding: 16, fontSize: 13.5 }}
                        dir={textDir}
                    >
                        <p
                            style={{
                                background: palette.raised,
                                borderRadius: Math.max(radius - 4, 8),
                                padding: '10px 12px',
                                maxWidth: '85%',
                            }}
                        >
                            {text('welcome')}
                        </p>
                        <p style={{ fontWeight: 600, fontSize: 12.5 }}>
                            {text('categoryPrompt')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {(categories.length > 0
                                ? categories
                                : [{ slug: 'general', label: '—' }]
                            ).map((category) => (
                                <span
                                    key={category.slug}
                                    style={{
                                        border: `1.5px solid ${palette.primary}`,
                                        color: dark
                                            ? palette.text
                                            : palette.primary,
                                        borderRadius: Math.max(radius / 1.5, 8),
                                        padding: '6px 12px',
                                        fontSize: 13,
                                        fontWeight: 500,
                                    }}
                                >
                                    {category.label}
                                </span>
                            ))}
                        </div>
                        {config.features.whatsapp && (
                            // The visitor's second option (the real panel offers it when a number is connected): drawn whenever the draft turns it on.
                            <span
                                data-testid="preview-whatsapp"
                                className="inline-flex w-fit items-center gap-2"
                                style={{
                                    background: palette.raised,
                                    borderRadius: Math.max(radius / 1.5, 8),
                                    padding: '8px 12px',
                                    fontSize: 13,
                                    fontWeight: 500,
                                }}
                            >
                                <MessageCircleMore size={16} aria-hidden />
                                {t('whatsapp.builder.preview_option')}
                            </span>
                        )}
                    </div>
                    <div
                        style={{
                            borderTop: `1px solid ${palette.border}`,
                            padding: 10,
                        }}
                        className="flex items-center gap-2"
                        dir={textDir}
                    >
                        {config.features.attachments && (
                            <Paperclip
                                size={18}
                                style={{ color: palette.muted }}
                                aria-hidden
                            />
                        )}
                        <span
                            style={{
                                background: palette.raised,
                                borderRadius: Math.max(radius - 4, 8),
                                color: palette.muted,
                                padding: '9px 12px',
                                fontSize: 13,
                            }}
                            className="flex-1"
                        >
                            {text('placeholder')}
                        </span>
                        <span
                            style={{
                                background: palette.primary,
                                color: palette.primaryText,
                                borderRadius: Math.max(radius - 4, 8),
                                padding: '8px 10px',
                            }}
                            aria-label={text('send')}
                            className="flex items-center"
                        >
                            <Send
                                size={16}
                                className="rtl:-scale-x-100"
                                aria-hidden
                            />
                        </span>
                    </div>
                    {config.features.poweredBy && (
                        <p
                            style={{
                                color: palette.muted,
                                fontSize: 11,
                                paddingBottom: 8,
                            }}
                            className="text-center"
                        >
                            {text('poweredBy')}
                        </p>
                    )}
                </div>
            )}

            {!(compact && panelOpen) && (
                <div
                    data-testid="preview-launcher"
                    data-style={launcher.style}
                    data-size={theme.launcherSize}
                    data-position={theme.position}
                    style={{
                        ...widgetFont,
                        position: 'absolute',
                        zIndex: 4,
                        bottom: theme.offsetY,
                        [side]: theme.offsetX,
                        perspective: 800,
                    }}
                >
                    <div className="pne-flip grid" data-flipped={flipped}>
                        <div
                            className="pne-face front flex items-center justify-center gap-2.5"
                            style={{
                                ...launcherSurface,
                                borderRadius:
                                    launcher.style === 'pill' ? size : '50%',
                                width:
                                    launcher.style === 'pill'
                                        ? undefined
                                        : size,
                                padding:
                                    launcher.style === 'pill' ? '0 22px' : 0,
                                fontSize: 15,
                                fontWeight: 600,
                            }}
                        >
                            {launcher.icon === 'custom' &&
                            launcher.iconUrl &&
                            isSecureUrl(launcher.iconUrl) ? (
                                <img
                                    src={launcher.iconUrl}
                                    alt=""
                                    style={{
                                        width: size * 0.46,
                                        height: size * 0.46,
                                    }}
                                    className="object-contain"
                                />
                            ) : (
                                <LauncherIcon
                                    size={Math.round(size * 0.44)}
                                    aria-hidden
                                />
                            )}
                            {launcher.style === 'pill' && (
                                <span style={{ whiteSpace: 'nowrap' }}>
                                    {launcher.label}
                                </span>
                            )}
                        </div>
                        <div
                            className="pne-face back flex items-center justify-center gap-2.5"
                            style={{
                                ...launcherSurface,
                                borderRadius:
                                    launcher.style === 'pill' ? size : '50%',
                                width:
                                    launcher.style === 'pill'
                                        ? undefined
                                        : size,
                                padding:
                                    launcher.style === 'pill' ? '0 14px' : 0,
                                fontSize: 14,
                                fontWeight: 600,
                            }}
                        >
                            <AgentFace
                                url={avatarUrl}
                                name={agentName}
                                size={
                                    launcher.style === 'pill'
                                        ? size - 14
                                        : size - 8
                                }
                                accent={palette.accent}
                                accentText={accentText}
                            />
                            {launcher.style === 'pill' && agentName && (
                                <span style={{ whiteSpace: 'nowrap' }}>
                                    {agentName}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/** A faceless stand-in for the customer's website. */
function MockSite({ dark, compact }: { dark: boolean; compact: boolean }) {
    const bar = dark ? '#1f2937' : '#e2e8f0';
    const card = dark ? '#0f172a' : '#ffffff';
    const line = dark ? '#1f2937' : '#e5e7eb';
    const block = (width: string, height: number, extra?: CSSProperties) => (
        <span
            style={{
                display: 'block',
                width,
                height,
                borderRadius: 6,
                background: bar,
                ...extra,
            }}
        />
    );

    return (
        <div aria-hidden>
            <div
                className="flex items-center gap-5"
                style={{
                    padding: compact ? '14px 18px' : '16px 28px',
                    background: card,
                    borderBottom: `1px solid ${line}`,
                }}
            >
                <span
                    style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        background: dark ? '#334155' : '#cbd5e1',
                    }}
                />
                {block('110px', 12)}
                {!compact && (
                    <span className="ms-auto flex gap-3.5">
                        {block('54px', 10)}
                        {block('54px', 10)}
                        {block('54px', 10)}
                    </span>
                )}
            </div>
            <div
                style={{
                    padding: compact ? '32px 18px 18px' : '56px 28px 28px',
                    maxWidth: 760,
                }}
            >
                {block('72%', 26, { marginBottom: 14 })}
                {block('48%', 26, { marginBottom: 18 })}
                {block('92%', 11, { marginBottom: 9 })}
                {block('86%', 11, { marginBottom: 9 })}
                {block('64%', 11, { marginBottom: 18 })}
                {block('132px', 38, {
                    borderRadius: 9,
                    background: dark ? '#334155' : '#cbd5e1',
                })}
            </div>
            <div
                className="grid gap-4"
                style={{
                    padding: compact ? '8px 18px' : '20px 28px',
                    gridTemplateColumns: compact
                        ? '1fr'
                        : 'repeat(3, minmax(0, 1fr))',
                }}
            >
                {[0, 1, 2].slice(0, compact ? 1 : 3).map((n) => (
                    <div
                        key={n}
                        style={{
                            background: card,
                            border: `1px solid ${line}`,
                            borderRadius: 14,
                            padding: 18,
                        }}
                    >
                        {block('55%', 12, { marginBottom: 12 })}
                        {block('100%', 9, { marginBottom: 8 })}
                        {block('70%', 9)}
                    </div>
                ))}
            </div>
        </div>
    );
}
