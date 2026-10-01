/**
 * Pure rules that turn the widget config into the state machine's `Flow`, plus the form validation of the pre-chat and offline
 * forms. The server enforces the same rules (and wins); validating here only saves a round trip and gives accessible,
 * field-level messages in the visitor's language.
 */
import {
    isOffline,
    needsPreChat,
    PRECHAT_FIELDS,
    type PanelConfig,
    type PreChatFieldName,
} from '@/embed/config/panel-config';
import type { MessageKey } from '@/embed/i18n';
import type { Flow, FormValues } from '@/embed/state/machine';

export const MAX_NAME = 120;
export const MAX_EMAIL = 190;
export const MIN_PHONE = 3;
export const MAX_PHONE = 40;
export const MAX_MESSAGE = 4000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9 +().-]+$/;

export function requiredFilled(config: PanelConfig, form: FormValues): boolean {
    return PRECHAT_FIELDS.every((name) => {
        const field = config.preChat.fields[name];

        return !field.enabled || !field.required || form[name].trim() !== '';
    });
}

export function deriveFlow(
    config: PanelConfig,
    options: { identified: boolean; form: FormValues },
): Flow {
    const availability = config.availability;
    // A signed identity that already answers every required field makes the form pointless (consent can never be pre-given).
    const satisfied =
        options.identified &&
        config.preChat.consentText === null &&
        requiredFilled(config, options.form);

    return {
        offline: isOffline(config),
        offlineReason:
            availability !== null && !availability.openNow
                ? 'hours'
                : 'no_agents',
        offlineForm: config.features.offlineForm,
        preChat: needsPreChat(config) && !satisfied,
        categoryCount: config.categories.length,
        rating: config.features.rating,
    };
}

export type FieldErrorKeys = Partial<Record<string, MessageKey>>;

type TextRule = { required: boolean; max: number };

function checkEmail(value: string, required: boolean): MessageKey | undefined {
    const text = value.trim();

    if (text === '') {
        return required ? 'embed.chat.field.error.required' : undefined;
    }

    if (text.length > MAX_EMAIL) {
        return 'embed.chat.field.error.too_long';
    }

    return EMAIL.test(text) ? undefined : 'embed.chat.field.error.email';
}

function checkPhone(value: string, required: boolean): MessageKey | undefined {
    const text = value.trim();

    if (text === '') {
        return required ? 'embed.chat.field.error.required' : undefined;
    }

    if (text.length > MAX_PHONE) {
        return 'embed.chat.field.error.too_long';
    }

    return text.length >= MIN_PHONE && PHONE.test(text)
        ? undefined
        : 'embed.chat.field.error.phone';
}

function checkText(value: string, rule: TextRule): MessageKey | undefined {
    const text = value.trim();

    if (text === '') {
        return rule.required ? 'embed.chat.field.error.required' : undefined;
    }

    return text.length > rule.max
        ? 'embed.chat.field.error.too_long'
        : undefined;
}

/** Pre-chat form: required fields per the widget config, plus the consent checkbox when the widget has consent text. */
export function validatePreChat(
    config: PanelConfig,
    values: FormValues,
): FieldErrorKeys {
    const errors: FieldErrorKeys = {};
    const check: Record<PreChatFieldName, () => MessageKey | undefined> = {
        name: () =>
            checkText(values.name, {
                required: config.preChat.fields.name.required,
                max: MAX_NAME,
            }),
        email: () =>
            checkEmail(values.email, config.preChat.fields.email.required),
        phone: () =>
            checkPhone(values.phone, config.preChat.fields.phone.required),
    };

    for (const name of PRECHAT_FIELDS) {
        if (!config.preChat.fields[name].enabled) {
            continue;
        }

        const error = check[name]();

        if (error !== undefined) {
            errors[name] = error;
        }
    }

    if (config.preChat.consentText !== null && !values.consent) {
        errors.consent = 'embed.chat.prechat.consent_required';
    }

    return errors;
}

export type OfflineValues = {
    name: string;
    email: string;
    message: string;
    category: string;
};

/** Offline form: name, email and message are always required. */
export function validateOffline(
    values: OfflineValues,
    categoryRequired: boolean,
    maxMessage: number = MAX_MESSAGE,
): FieldErrorKeys {
    const errors: FieldErrorKeys = {};
    const name = checkText(values.name, { required: true, max: MAX_NAME });
    const email = checkEmail(values.email, true);
    const message = checkText(values.message, {
        required: true,
        max: maxMessage,
    });

    if (name !== undefined) {
        errors.name = name;
    }

    if (email !== undefined) {
        errors.email = email;
    }

    if (message !== undefined) {
        errors.message = message;
    }

    if (categoryRequired && values.category === '') {
        errors.category = 'embed.chat.field.error.required';
    }

    return errors;
}

export function hasErrors(errors: FieldErrorKeys): boolean {
    return Object.keys(errors).length > 0;
}
