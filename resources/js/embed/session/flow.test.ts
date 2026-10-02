import { describe, expect, it } from 'vite-plus/test';
import { buildPanelConfig } from '@/embed/config/panel-config';
import {
    deriveFlow,
    hasErrors,
    requiredFilled,
    validateOffline,
    validatePreChat,
} from '@/embed/session/flow';
import { EMPTY_FORM } from '@/embed/state/machine';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { loaderBoot } from '@/tests/embed-harness';

const config = (
    preChat?: unknown,
    availability?: unknown,
    extra: Record<string, unknown> = {},
) =>
    buildPanelConfig({
        boot: loaderBoot({
            ...(availability === undefined ? {} : { availability }),
            config: {
                ...(bootConfig().config as object),
                ...(preChat === undefined ? {} : { preChat }),
                ...extra,
            },
        }),
    });

const fields = (
    patch: Record<string, { enabled: boolean; required: boolean }> = {},
) => ({
    fields: {
        name: { enabled: true, required: true },
        email: { enabled: true, required: false },
        phone: { enabled: false, required: false },
        ...patch,
    },
    consentText: null as string | null,
});

describe('pre-chat validation', () => {
    it('requires the required fields and leaves optional ones empty', () => {
        expect(validatePreChat(config(), EMPTY_FORM)).toEqual({
            name: 'embed.chat.field.error.required',
        });
        expect(
            validatePreChat(config(), { ...EMPTY_FORM, name: 'Vera' }),
        ).toEqual({});
        expect(
            hasErrors(
                validatePreChat(config(), { ...EMPTY_FORM, name: 'Vera' }),
            ),
        ).toBe(false);
    });

    it('checks the email and phone formats and lengths when given', () => {
        const strict = config(
            fields({
                email: { enabled: true, required: true },
                phone: { enabled: true, required: true },
            }),
        );

        expect(
            validatePreChat(strict, {
                ...EMPTY_FORM,
                name: 'V',
                email: 'nope',
                phone: 'abc',
            }),
        ).toEqual({
            email: 'embed.chat.field.error.email',
            phone: 'embed.chat.field.error.phone',
        });
        expect(
            validatePreChat(strict, {
                ...EMPTY_FORM,
                name: 'V',
                email: 'a@b.co',
                phone: '+1 (555) 010-9999',
            }),
        ).toEqual({});
        expect(
            validatePreChat(strict, {
                ...EMPTY_FORM,
                name: 'x'.repeat(121),
                email: 'a@b.co',
                phone: '+1555',
            }),
        ).toEqual({
            name: 'embed.chat.field.error.too_long',
        });
        expect(
            validatePreChat(strict, {
                ...EMPTY_FORM,
                name: 'V',
                email: `${'a'.repeat(190)}@b.co`,
                phone: '12',
            }).email,
        ).toBe('embed.chat.field.error.too_long');
        expect(
            validatePreChat(config(), {
                ...EMPTY_FORM,
                name: 'V',
                email: 'bad',
            }).email,
        ).toBe('embed.chat.field.error.email');
    });

    it('does not validate fields the widget does not show', () => {
        const noName = config(
            fields({ name: { enabled: false, required: false } }),
        );

        expect(
            validatePreChat(noName, { ...EMPTY_FORM, phone: 'garbage' }),
        ).toEqual({});
    });

    it('consent must be ticked when the widget has consent text', () => {
        const consent = config({ ...fields(), consentText: 'I agree' });

        expect(validatePreChat(consent, { ...EMPTY_FORM, name: 'V' })).toEqual({
            consent: 'embed.chat.prechat.consent_required',
        });
        expect(
            validatePreChat(consent, {
                ...EMPTY_FORM,
                name: 'V',
                consent: true,
            }),
        ).toEqual({});
    });
});

describe('offline form validation', () => {
    const valid = {
        name: 'Vera',
        email: 'v@x.test',
        message: 'Hi',
        category: 'billing',
    };

    it('requires name, email and message; the topic only when there are several', () => {
        expect(validateOffline(valid, true)).toEqual({});
        expect(
            validateOffline(
                { ...valid, name: ' ', email: '', message: '' },
                false,
            ),
        ).toEqual({
            name: 'embed.chat.field.error.required',
            email: 'embed.chat.field.error.required',
            message: 'embed.chat.field.error.required',
        });
        expect(validateOffline({ ...valid, category: '' }, true)).toEqual({
            category: 'embed.chat.field.error.required',
        });
        expect(validateOffline({ ...valid, category: '' }, false)).toEqual({});
        expect(validateOffline({ ...valid, email: 'nope' }, false).email).toBe(
            'embed.chat.field.error.email',
        );
        expect(
            validateOffline({ ...valid, message: 'x'.repeat(4001) }, false)
                .message,
        ).toBe('embed.chat.field.error.too_long');
    });
});

describe('deriveFlow', () => {
    it('reads offline, reason, form, topics and rating from the config', () => {
        const open = deriveFlow(config(), {
            identified: false,
            form: EMPTY_FORM,
        });

        expect(open).toEqual({
            offline: false,
            offlineReason: 'no_agents',
            offlineForm: true,
            preChat: true,
            categoryCount: 2,
            rating: true,
            whatsapp: false,
        });

        const closed = deriveFlow(
            config(undefined, {
                online: false,
                openNow: false,
                nextOpenAt: null,
                categories: [],
                whatsapp: { enabled: false },
            }),
            { identified: false, form: EMPTY_FORM },
        );

        expect(closed).toMatchObject({ offline: true, offlineReason: 'hours' });
    });

    it('offers WhatsApp exactly when the panel config does (the feature AND a connected session, already combined)', () => {
        const base = config();

        expect(
            deriveFlow(
                { ...base, features: { ...base.features, whatsapp: true } },
                { identified: false, form: EMPTY_FORM },
            ).whatsapp,
        ).toBe(true);
        expect(
            deriveFlow(
                { ...base, features: { ...base.features, whatsapp: false } },
                { identified: false, form: EMPTY_FORM },
            ).whatsapp,
        ).toBe(false);
    });

    it('a signed identity that fills the required fields makes the form unnecessary (never when consent is needed)', () => {
        const filled = { ...EMPTY_FORM, name: 'Ida' };

        expect(requiredFilled(config(), filled)).toBe(true);
        expect(
            deriveFlow(config(), { identified: true, form: filled }).preChat,
        ).toBe(false);
        expect(
            deriveFlow(config(), { identified: false, form: filled }).preChat,
        ).toBe(true);
        expect(
            deriveFlow(config(), { identified: true, form: EMPTY_FORM })
                .preChat,
        ).toBe(true);
        expect(
            deriveFlow(config({ ...fields(), consentText: 'I agree' }), {
                identified: true,
                form: filled,
            }).preChat,
        ).toBe(true);
    });
});
