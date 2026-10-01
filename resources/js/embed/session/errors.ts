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
