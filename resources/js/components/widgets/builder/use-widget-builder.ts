import { useReducer, useState } from 'react';
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
    mapApiErrors,
    settingsPatch,
    SLICES,
    validateBuilderDoc,
    type BuilderTab,
    type FieldErrors,
    type SliceName,
} from '@/components/widgets/builder-state';
import { useUnsavedChangesGuard } from '@/components/widgets/use-unsaved-guard';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError, isApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { WidgetBuilderData, WidgetData } from '@/types/widgets';

export type BuilderStatus = 'idle' | 'saving' | 'publishing';

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

/**
 * Wires the builder reducer to the management API: validate -> save the dirty slices one by one
 * (each independent, errors mapped onto fields) -> publish. The page only renders what this returns.
 */
export function useWidgetBuilder(data: WidgetBuilderData) {
    const { t } = useTrans();
    const [state, dispatch] = useReducer(
        builderReducer,
        data,
        createBuilderState,
    );
    const [status, setStatus] = useState<BuilderStatus>('idle');
    const [message, setMessage] = useState<BuilderMessage | null>(null);
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

            case 'config':
                await api.put(
                    widgetsRoutes.api.widgets.draft(ulid),
                    draftPayload(doc.config),
                );
                dispatch({ type: 'saved', slice, snapshot: doc.config });

                return;

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

    async function saveDraft(): Promise<SaveOutcome> {
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
                        ...mapApiErrors(slice, error.details),
                    };
                } else {
                    general = describeApiError(error, t);
                }
            }
        }

        setStatus('idle');

        if (failed.length === 0) {
            announce('success', t('builder.save.done'));

            return { ok: true, saved };
        }

        if (Object.keys(errors).length > 0) {
            dispatch({ type: 'errors/set', errors });
        }

        announce('error', general ?? t('builder.save.failed'));

        return { ok: false, saved, failed, tab: firstTabWithError(errors) };
    }

    async function publish(): Promise<SaveOutcome> {
        const outcome = await saveDraft();

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
            announce('error', describeApiError(error, t));
            setStatus('idle');

            return { ok: false, saved: outcome.saved, failed: [], tab: null };
        }

        setStatus('idle');

        return outcome;
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
        rotateSecret,
    };
}
