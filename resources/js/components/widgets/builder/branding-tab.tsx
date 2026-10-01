import {
    ArrowDownLeft,
    ArrowDownRight,
    CircleHelp,
    ImageIcon,
    MessageCircle,
    Monitor,
    Moon,
    Sparkles,
    Sun,
    Wand2,
} from 'lucide-react';
import { useId } from 'react';
import { describedBy, Field } from '@/components/setup/field';
import { firstError, sectionAction } from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    ColorField,
    ContrastHint,
    NumberField,
    SectionCard,
    SegmentedChoice,
    TextField,
} from '@/components/widgets/form-bits';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import {
    FONT_URL_HOSTS,
    LAUNCHER_PIXELS,
    readableTextOn,
} from '@/lib/widget-config';
import type {
    LauncherConfig,
    LauncherIcon,
    LauncherSize,
    LauncherStyle,
    ShadowLevel,
    ThemeConfig,
    ThemeMode,
    WidgetCorner,
} from '@/types/widgets';

const blankToNull = (value: string): string | null =>
    value.trim() === '' ? null : value.trim();

export function BrandingTab({ state, dispatch }: TabProps) {
    const { t } = useTrans();
    const uid = useId();
    const { theme, launcher } = state.doc.config;
    const err = (path: string) => firstError(state.errors, path);
    const patchTheme = (patch: Partial<ThemeConfig>) =>
        dispatch(sectionAction('theme', patch));
    const patchLauncher = (patch: Partial<LauncherConfig>) =>
        dispatch(sectionAction('launcher', patch));

    return (
        <div className="grid gap-5" data-testid="builder-panel-branding">
            <SectionCard
                title={t('builder.branding.colors_title')}
                description={t('builder.branding.colors_description')}
            >
                <SegmentedChoice<ThemeMode>
                    legend={t('builder.branding.mode')}
                    name={`${uid}-mode`}
                    value={theme.mode}
                    onChange={(mode) => patchTheme({ mode })}
                    hint={t('builder.branding.mode_hint')}
                    options={[
                        {
                            value: 'auto',
                            label: t('builder.branding.mode_auto'),
                            icon: <Monitor className="size-4" aria-hidden />,
                        },
                        {
                            value: 'light',
                            label: t('builder.branding.mode_light'),
                            icon: <Sun className="size-4" aria-hidden />,
                        },
                        {
                            value: 'dark',
                            label: t('builder.branding.mode_dark'),
                            icon: <Moon className="size-4" aria-hidden />,
                        },
                    ]}
                    variant="segmented"
                    testId="builder-theme-mode"
                />

                <div className="grid gap-5 sm:grid-cols-2">
                    <div className="grid content-start gap-2">
                        <ColorField
                            id={`${uid}-primary`}
                            label={t('builder.branding.primary')}
                            hint={t('builder.branding.primary_hint')}
                            value={theme.primary}
                            onValueChange={(primary) => patchTheme({ primary })}
                            error={err('config.theme.primary')}
                        />
                    </div>
                    <div className="grid content-start gap-2">
                        <ColorField
                            id={`${uid}-primary-text`}
                            label={t('builder.branding.primary_text')}
                            hint={t('builder.branding.primary_text_hint')}
                            value={theme.primaryText}
                            onValueChange={(primaryText) =>
                                patchTheme({ primaryText })
                            }
                            error={err('config.theme.primaryText')}
                        />
                        <div>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                data-testid="builder-auto-primary-text"
                                onClick={() =>
                                    patchTheme({
                                        primaryText: readableTextOn(
                                            theme.primary,
                                        ),
                                    })
                                }
                            >
                                <Wand2 aria-hidden />
                                {t('builder.branding.auto_text')}
                            </Button>
                        </div>
                    </div>
                    <ColorField
                        id={`${uid}-accent`}
                        label={t('builder.branding.accent')}
                        hint={t('builder.branding.accent_hint')}
                        value={theme.accent}
                        onValueChange={(accent) => patchTheme({ accent })}
                        error={err('config.theme.accent')}
                    />
                    <ColorField
                        id={`${uid}-surface`}
                        label={t('builder.branding.surface')}
                        hint={t('builder.branding.surface_hint')}
                        value={theme.surface}
                        onValueChange={(surface) => patchTheme({ surface })}
                        error={err('config.theme.surface')}
                    />
                    <ColorField
                        id={`${uid}-text`}
                        label={t('builder.branding.text')}
                        hint={t('builder.branding.text_hint')}
                        value={theme.text}
                        onValueChange={(text) => patchTheme({ text })}
                        error={err('config.theme.text')}
                    />
                </div>

                <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                        {t('builder.branding.contrast_title')}
                    </p>
                    <ContrastHint
                        testId="builder-contrast-button"
                        foreground={theme.primaryText}
                        background={theme.primary}
                        label={t('builder.branding.contrast_button')}
                    />
                    <ContrastHint
                        testId="builder-contrast-body"
                        foreground={theme.text}
                        background={theme.surface}
                        label={t('builder.branding.contrast_body')}
                    />
                    <ContrastHint
                        testId="builder-contrast-accent"
                        foreground={theme.accent}
                        background={theme.surface}
                        label={t('builder.branding.contrast_accent')}
                    />
                </div>
            </SectionCard>

            <SectionCard
                title={t('builder.branding.type_title')}
                description={t('builder.branding.type_description')}
            >
                <TextField
                    id={`${uid}-font`}
                    label={t('builder.branding.font_family')}
                    hint={t('builder.branding.font_family_hint')}
                    value={theme.fontFamily}
                    onValueChange={(fontFamily) => patchTheme({ fontFamily })}
                    error={err('config.theme.fontFamily')}
                    dir="ltr"
                    spellCheck={false}
                />
                <TextField
                    id={`${uid}-font-url`}
                    type="url"
                    label={t('builder.branding.font_url')}
                    hint={t('builder.branding.font_url_hint', {
                        hosts: FONT_URL_HOSTS.join(', '),
                    })}
                    value={theme.fontUrl ?? ''}
                    onValueChange={(value) =>
                        patchTheme({ fontUrl: blankToNull(value) })
                    }
                    placeholder="https://fonts.googleapis.com/css2?family=…"
                    error={err('config.theme.fontUrl')}
                    dir="ltr"
                    spellCheck={false}
                />

                <Field
                    id={`${uid}-radius`}
                    label={t('builder.branding.radius')}
                    hint={t('builder.branding.radius_hint')}
                    error={err('config.theme.radius')}
                >
                    <div className="flex items-center gap-3">
                        <input
                            id={`${uid}-radius`}
                            type="range"
                            min={LIMITS.radius.min}
                            max={LIMITS.radius.max}
                            step={1}
                            value={theme.radius}
                            onChange={(event) =>
                                patchTheme({
                                    radius: Number(event.target.value),
                                })
                            }
                            aria-describedby={describedBy(`${uid}-radius`, {
                                hint: true,
                                error: err('config.theme.radius'),
                            })}
                            className="h-2 w-full max-w-xs cursor-pointer accent-[var(--primary)] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        />
                        <output
                            htmlFor={`${uid}-radius`}
                            className="w-12 text-sm tabular-nums"
                        >
                            {theme.radius}px
                        </output>
                    </div>
                </Field>

                <SegmentedChoice<ShadowLevel>
                    legend={t('builder.branding.shadow')}
                    name={`${uid}-shadow`}
                    value={theme.shadow}
                    onChange={(shadow) => patchTheme({ shadow })}
                    options={[
                        {
                            value: 'none',
                            label: t('builder.branding.shadow_none'),
                        },
                        {
                            value: 'soft',
                            label: t('builder.branding.shadow_soft'),
                        },
                        {
                            value: 'strong',
                            label: t('builder.branding.shadow_strong'),
                        },
                    ]}
                    variant="segmented"
                    testId="builder-theme-shadow"
                />
            </SectionCard>

            <SectionCard
                title={t('builder.branding.launcher_title')}
                description={t('builder.branding.launcher_description')}
            >
                <div className="grid gap-5">
                    <SegmentedChoice<LauncherStyle>
                        legend={t('builder.branding.launcher_style')}
                        name={`${uid}-launcher-style`}
                        value={launcher.style}
                        onChange={(style) => patchLauncher({ style })}
                        options={[
                            {
                                value: 'bubble',
                                label: t('builder.branding.style_bubble'),
                            },
                            {
                                value: 'pill',
                                label: t('builder.branding.style_pill'),
                            },
                        ]}
                        variant="segmented"
                        testId="builder-launcher-style"
                    />
                    <SegmentedChoice<LauncherSize>
                        legend={t('builder.branding.launcher_size')}
                        name={`${uid}-launcher-size`}
                        value={theme.launcherSize}
                        onChange={(launcherSize) =>
                            patchTheme({ launcherSize })
                        }
                        options={(['sm', 'md', 'lg'] as const).map((size) => ({
                            value: size,
                            label: `${t(`builder.branding.size_${size}`)} · ${LAUNCHER_PIXELS[size]}px`,
                        }))}
                        variant="segmented"
                        testId="builder-launcher-size"
                    />
                </div>

                <SegmentedChoice<LauncherIcon>
                    legend={t('builder.branding.launcher_icon')}
                    name={`${uid}-launcher-icon`}
                    value={launcher.icon}
                    onChange={(icon) => patchLauncher({ icon })}
                    options={[
                        {
                            value: 'chat',
                            label: t('builder.branding.icon_chat'),
                            icon: (
                                <MessageCircle className="size-4" aria-hidden />
                            ),
                        },
                        {
                            value: 'help',
                            label: t('builder.branding.icon_help'),
                            icon: <CircleHelp className="size-4" aria-hidden />,
                        },
                        {
                            value: 'sparkle',
                            label: t('builder.branding.icon_sparkle'),
                            icon: <Sparkles className="size-4" aria-hidden />,
                        },
                        {
                            value: 'custom',
                            label: t('builder.branding.icon_custom'),
                            icon: <ImageIcon className="size-4" aria-hidden />,
                        },
                    ]}
                    testId="builder-launcher-icon"
                />

                {launcher.icon === 'custom' && (
                    <TextField
                        id={`${uid}-icon-url`}
                        type="url"
                        label={t('builder.branding.icon_url')}
                        hint={t('builder.branding.icon_url_hint')}
                        value={launcher.iconUrl ?? ''}
                        onValueChange={(value) =>
                            patchLauncher({ iconUrl: blankToNull(value) })
                        }
                        placeholder="https://"
                        error={err('config.launcher.iconUrl')}
                        dir="ltr"
                        spellCheck={false}
                    />
                )}

                <TextField
                    id={`${uid}-label`}
                    label={t('builder.branding.launcher_label')}
                    hint={
                        launcher.style === 'pill'
                            ? t('builder.branding.launcher_label_hint')
                            : t('builder.branding.launcher_label_hint_bubble')
                    }
                    value={launcher.label}
                    onValueChange={(label) => patchLauncher({ label })}
                    maxLength={LIMITS.launcherLabelLength}
                    error={err('config.launcher.label')}
                />

                <TextField
                    id={`${uid}-avatar`}
                    type="url"
                    label={t('builder.branding.launcher_avatar')}
                    hint={t('builder.branding.launcher_avatar_hint')}
                    value={launcher.avatarUrl ?? ''}
                    onValueChange={(value) =>
                        patchLauncher({ avatarUrl: blankToNull(value) })
                    }
                    placeholder="https://"
                    error={err('config.launcher.avatarUrl')}
                    dir="ltr"
                    spellCheck={false}
                />
            </SectionCard>

            <SectionCard
                title={t('builder.branding.placement_title')}
                description={t('builder.branding.placement_description')}
            >
                <SegmentedChoice<WidgetCorner>
                    legend={t('builder.branding.position')}
                    name={`${uid}-position`}
                    value={theme.position}
                    onChange={(position) => patchTheme({ position })}
                    hint={t('builder.branding.position_hint')}
                    options={[
                        {
                            value: 'bottom-right',
                            label: t('builder.branding.position_right'),
                            icon: (
                                <ArrowDownRight
                                    className="size-4"
                                    aria-hidden
                                />
                            ),
                        },
                        {
                            value: 'bottom-left',
                            label: t('builder.branding.position_left'),
                            icon: (
                                <ArrowDownLeft className="size-4" aria-hidden />
                            ),
                        },
                    ]}
                    variant="segmented"
                    testId="builder-theme-position"
                />

                <div className="grid gap-5 sm:grid-cols-2">
                    <NumberField
                        id={`${uid}-offset-x`}
                        label={t('builder.branding.offset_x')}
                        value={theme.offsetX}
                        onValueChange={(offsetX) => patchTheme({ offsetX })}
                        min={LIMITS.offset.min}
                        max={LIMITS.offset.max}
                        suffix="px"
                        error={err('config.theme.offsetX')}
                    />
                    <NumberField
                        id={`${uid}-offset-y`}
                        label={t('builder.branding.offset_y')}
                        value={theme.offsetY}
                        onValueChange={(offsetY) => patchTheme({ offsetY })}
                        min={LIMITS.offset.min}
                        max={LIMITS.offset.max}
                        suffix="px"
                        error={err('config.theme.offsetY')}
                    />
                    <NumberField
                        id={`${uid}-panel-width`}
                        label={t('builder.branding.panel_width')}
                        hint={t('builder.branding.panel_hint')}
                        value={theme.panelWidth}
                        onValueChange={(panelWidth) =>
                            patchTheme({ panelWidth })
                        }
                        min={LIMITS.panelWidth.min}
                        max={LIMITS.panelWidth.max}
                        suffix="px"
                        error={err('config.theme.panelWidth')}
                    />
                    <NumberField
                        id={`${uid}-panel-height`}
                        label={t('builder.branding.panel_height')}
                        value={theme.panelHeight}
                        onValueChange={(panelHeight) =>
                            patchTheme({ panelHeight })
                        }
                        min={LIMITS.panelHeight.min}
                        max={LIMITS.panelHeight.max}
                        suffix="px"
                        error={err('config.theme.panelHeight')}
                    />
                    <NumberField
                        id={`${uid}-z-index`}
                        label={t('builder.branding.z_index')}
                        hint={t('builder.branding.z_index_hint')}
                        value={theme.zIndex}
                        onValueChange={(zIndex) => patchTheme({ zIndex })}
                        min={LIMITS.zIndex.min}
                        max={LIMITS.zIndex.max}
                        error={err('config.theme.zIndex')}
                    />
                </div>
            </SectionCard>
        </div>
    );
}
