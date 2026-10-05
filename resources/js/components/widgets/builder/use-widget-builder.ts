import { useReducer, useRef, useState } from 'react';
import {
    builderReducer,
    createBuilderState,
    dirtySlices,
    domainsFromResponse,
    draftPayload,
    firstTabWithError,
    greetingsFromResponse,
    greetingsPayload,
    hasUnpublished,
    isDirty,
    LIVE_SLICES,
    mapApiErrors,
    settingsPatch,
    SLICES,
    validateBuilderDoc,
    type BuilderTab,
    type FieldErrors,
    type SliceName,
} from '@/components/widgets/builder-state';
import { builderFieldLabel } from '@/components/widgets/builder-labels';
import { useUnsavedChangesGuard } from '@/components/widgets/use-unsaved-guard';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetBuilderData, WidgetData } from '@/types/widgets';

export type BuilderStatus = 'idle' | 'saving' | 'publishing' | 'switching';

export type BuilderMessage = {
    id: number;
    tone: 'success' | 'error' | 'info';
    text: string;
};

export type SaveOutcome =
    | { ok: true; saved: SliceName[] }
    | {
          ok: false;
          saved: SliceName[];
          failed: SliceName[];
          tab: BuilderTab | null;
      };

/** "settings, domains and categories" in the viewer's language (plain commas if `Intl` cannot). */
function formatList(items: string[], locale: string): string {
    try {
        return new Intl.ListFormat(locale.replace('_', '-'), {
            style: 'long',
            type: 'conjunction',
        }).format(items);
    } catch {
        return items.join(', ');
    }
}

/**
 * Wires the builder reducer to the management API: validate -> save the dirty slices one by one
 * (each independent, errors mapped onto fields) -> publish. The page only renders what this returns.
 */
export function useWidgetBuilder(data: WidgetBuilderData) {
    const translator = useTrans();
    const { t, locale } = translator;
    const [state, dispatch] = useReducer(
        builderReducer,
        data,
        createBuilderState,
    );
    const [status, setStatus] = useState<BuilderStatus>('idle');
    const [message, setMessage] = useState<BuilderMessage | null>(null);
    /** A second click while a save or publish is still running (the buttons only disable after the next render) must not start another. */
    const inFlight = useRef(false);
    const dirty = isDirty(state);
    const ulid = state.meta.ulid;

    useUnsavedChangesGuard(dirty, t('builder.leave_confirm'));

    function announce(tone: BuilderMessage['tone'], text: string) {
        setMessage((current) => ({ id: (current?.id ?? 0) + 1, tone, text }));
    }

    async function saveSlice(slice: SliceName): Promise<void> {
        const { doc } = state;

        switch (slice) {
            case 'settings': {
                const widget = await api.patch<Partial<WidgetData>>(
                    widgetsRoutes.api.widgets.show(ulid),
                    settingsPatch(state),
                );

                dispatch({ type: 'saved', slice, snapshot: doc.settings });
                dispatch({
                    type: 'meta',
                    patch: {
                        updatedAt: widget.updated_at ?? state.meta.updatedAt,
                        hasIdentitySecret:
                            widget.has_identity_secret ??
                            state.meta.hasIdentitySecret,
                        whatsappConnected:
                            widget.whatsapp_connected ??
                            state.meta.whatsappConnected,
                    },
                });

                return;
            }

            case 'config': {
                const payload = draftPayload(doc.config);

                await api.put(widgetsRoutes.api.widgets.draft(ulid), payload);
                // What the server keeps (a cleared launcher label is back at its default).
                dispatch({
                    type: 'saved',
                    slice,
                    snapshot: doc.config,
                    normalised: payload.config,
                });

                return;
            }

            case 'greetings': {
                const response = await api.put<unknown>(
                    widgetsRoutes.api.widgets.greetings(ulid),
                    greetingsPayload(doc.greetings),
                );

                dispatch({
                    type: 'saved',
                    slice,
                    snapshot: doc.greetings,
                    normalised: greetingsFromResponse(response) ?? undefined,
                });

                return;
            }

            case 'domains': {
                const response = await api.put<unknown>(
                    widgetsRoutes.api.widgets.domains(ulid),
                    { domains: doc.domains },
                );

                dispatch({
                    type: 'saved',
                    slice,
                    snapshot: doc.domains,
                    normalised: domainsFromResponse(response) ?? undefined,
                });

                return;
            }

            case 'categories':
                await api.put(widgetsRoutes.api.widgets.categories(ulid), {
                    category_ulids: doc.categoryUlids,
                });
                dispatch({ type: 'saved', slice, snapshot: doc.categoryUlids });
        }
    }

    /** An exception nobody planned for: never a silent dead button, always a visible message. */
    function failUnexpectedly(): SaveOutcome {
        setStatus('idle');
        announce('error', t('builder.save.unexpected'));

        return { ok: false, saved: [], failed: [], tab: null };
    }

    /** What a successful save changed for visitors: live slices now, the design only after Publish. */
    function savedMessage(saved: SliceName[]): string {
        const live = saved.filter((slice) => LIVE_SLICES.includes(slice));
        const sections = formatList(
            live.map((slice) => t(`builder.slice.${slice}`)),
            locale,
        );

        if (live.length === 0) {
            return t('builder.save.done');
        }

        return saved.includes('config')
            ? t('builder.save.done_mixed', { sections })
            : t('builder.save.done_live', { sections });
    }

    async function runSave(): Promise<SaveOutcome> {
        const clientErrors = validateBuilderDoc(
            state.doc,
            t,
            window.location.origin,
        );

        if (Object.keys(clientErrors).length > 0) {
            dispatch({ type: 'errors/set', errors: clientErrors });
            announce('error', t('builder.save.invalid'));

            return {
                ok: false,
                saved: [],
                failed: [],
                tab: firstTabWithError(clientErrors),
            };
        }

        dispatch({ type: 'errors/clear' });

        const pending = SLICES.filter((slice) =>
            dirtySlices(state).includes(slice),
        );

        if (pending.length === 0) {
            return { ok: true, saved: [] };
        }

        setStatus('saving');

        const saved: SliceName[] = [];
        const failed: SliceName[] = [];
        let errors: FieldErrors = {};
        let general: string | null = null;

        for (const slice of pending) {
            try {
                await saveSlice(slice);
                saved.push(slice);
            } catch (error) {
                failed.push(slice);

                if (isApiError(error) && error.isValidation) {
                    errors = {
                        ...errors,
                        ...mapApiErrors(slice, error.details, (path) =>
                            builderFieldLabel(path, translator),
                        ),
                    };
                } else {
                    general = describeApiError(error, t);
                }
            }
        }

        setStatus('idle');

        if (failed.length === 0) {
            announce('success', savedMessage(saved));

            return { ok: true, saved };
        }

        if (Object.keys(errors).length > 0) {
            dispatch({ type: 'errors/set', errors });
        }

        announce('error', general ?? t('builder.save.failed'));

        return { ok: false, saved, failed, tab: firstTabWithError(errors) };
    }

    async function alone(
        run: () => Promise<SaveOutcome>,
    ): Promise<SaveOutcome> {
        if (inFlight.current) {
            return { ok: false, saved: [], failed: [], tab: null };
        }

        inFlight.current = true;

        try {
            return await run();
        } finally {
            inFlight.current = false;
        }
    }

    async function saveWithoutGuard(): Promise<SaveOutcome> {
        try {
            return await runSave();
        } catch {
            return failUnexpectedly();
        }
    }

    function saveDraft(): Promise<SaveOutcome> {
        return alone(saveWithoutGuard);
    }

    function publish(): Promise<SaveOutcome> {
        return alone(publishWithoutGuard);
    }

    async function publishWithoutGuard(): Promise<SaveOutcome> {
        const outcome = await saveWithoutGuard();

        if (!outcome.ok) {
            return outcome;
        }

        setStatus('publishing');

        try {
            const widget = await api.post<WidgetData>(
                widgetsRoutes.api.widgets.publish(ulid),
            );

            dispatch({ type: 'published', widget });
            announce(
                'success',
                t('builder.publish.done', { version: widget.config_version }),
            );
        } catch (error) {
            announce(
                'error',
                isApiError(error)
                    ? describeApiError(error, t)
                    : t('builder.save.unexpected'),
            );
            setStatus('idle');

            return { ok: false, saved: outcome.saved, failed: [], tab: null };
        }

        setStatus('idle');

        return outcome;
    }

    /**
     * Takes the widget live / offline: its own request, applied immediately, independent of the
     * dirty slices. Resolves to `null` on success or the message to show next to the confirm button.
     */
    async function setEnabled(next: boolean): Promise<string | null> {
        setStatus('switching');

        try {
            const widget = await api.patch<Partial<WidgetData>>(
                widgetsRoutes.api.widgets.show(ulid),
                { is_enabled: next },
            );

            dispatch({ type: 'enabled', value: widget.is_enabled ?? next });
            dispatch({
                type: 'meta',
                patch: { updatedAt: widget.updated_at ?? state.meta.updatedAt },
            });
            announce(
                'success',
                t(
                    next
                        ? 'builder.enabled.done_live'
                        : 'builder.enabled.done_offline',
                ),
            );

            return null;
        } catch (error) {
            return isApiError(error)
                ? describeApiError(error, t)
                : t('builder.save.unexpected');
        } finally {
            setStatus('idle');
        }
    }

    async function rotateSecret(): Promise<string> {
        const result = await api.post<{ identity_secret: string }>(
            widgetsRoutes.api.widgets.rotateSecret(ulid),
        );

        dispatch({ type: 'meta', patch: { hasIdentitySecret: true } });

        return result.identity_secret;
    }

    return {
        state,
        dispatch,
        dirty,
        hasUnpublished: hasUnpublished(state),
        status,
        message,
        saveDraft,
        publish,
        setEnabled,
        rotateSecret,
    };
}
