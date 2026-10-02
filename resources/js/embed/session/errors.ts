/** Turns API failures into what the state machine and the UI understand: a notice code, or field-level messages. */
import {
    isVisitorApiError,
    type VisitorApiError,
} from '@/lib/chat-api/visitor';
import type { CreateFailure, FieldErrors, Notice } from '@/embed/state/machine';

export function toNotice(error: unknown): Notice {
    if (!isVisitorApiError(error)) {
        return { code: 'generic' };
    }

    if (error.isIdentityRejected) {
        return { code: 'identity' };
    }

    switch (error.code) {
        case 'feature_disabled':
            return { code: 'feature_disabled' };
        case 'whatsapp_unavailable':
            return { code: 'whatsapp_unavailable' };
        case 'rate_limited':
            return { code: 'rate_limited', seconds: error.retryAfter ?? 5 };
        case 'network':
            return { code: 'network' };
        case 'widget_not_found':
        case 'origin_not_allowed':
            return { code: 'unavailable' };
        case 'session_revoked':
            return { code: 'session_expired' };
        default:
            return { code: 'generic' };
    }
}

/** First message per field; `visitor.name` and `name` are the same field to the form. */
export function fieldErrorsOf(error: VisitorApiError): FieldErrors {
    const out: FieldErrors = {};

    for (const [field, messages] of Object.entries(error.details)) {
        const key = field.split('.').pop() ?? field;

        if (messages[0] !== undefined && out[key] === undefined) {
            out[key] = messages[0];
        }
    }

    return out;
}

export function toCreateFailure(error: unknown): CreateFailure {
    if (isVisitorApiError(error)) {
        if (error.code === 'no_agents') {
            return { kind: 'no_agents' };
        }

        // A signed identity the server refused is not a form field: say so, and do not offer a retry loop.
        if (error.status === 422 && !error.isIdentityRejected) {
            const errors = fieldErrorsOf(error);

            if (Object.keys(errors).length > 0) {
                return { kind: 'validation', errors };
            }
        }
    }

    return { kind: 'notice', notice: toNotice(error) };
}

/**
 * What a failed WhatsApp hand-off means for the screen: no connected session (`409`, whatever the code says: nothing the visitor can fix)
 * is its own message that points back to the chat; a refused topic (`422 details.category`) goes under the topic picker; everything else is
 * the usual notice (`403 feature_disabled`, the rate limit with its seconds, the network).
 */
export function toHandoffFailure(error: unknown): CreateFailure {
    if (isVisitorApiError(error)) {
        if (error.status === 409) {
            return {
                kind: 'notice',
                notice: { code: 'whatsapp_unavailable' },
            };
        }

        if (error.status === 422 && 'category' in error.details) {
            return {
                kind: 'validation',
                errors: { category: error.details.category[0] },
            };
        }
    }

    return { kind: 'notice', notice: toNotice(error) };
}
