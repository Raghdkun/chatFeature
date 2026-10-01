/** Why an agent's message could not be sent, from the API error: decides the text under the bubble and whether "Retry" is offered. */
import { isApiError } from '@/lib/api-client';
import type { MessageFailure } from '@/lib/chat/types';

export function failureOf(error: unknown): MessageFailure {
    if (!isApiError(error)) {
        return 'unknown';
    }

    if (error.status === 422) {
        return 'body' in error.details ? 'too_long' : 'rejected';
    }

    if (error.status === 403) {
        return 'forbidden';
    }

    if (error.code === 'conversation_not_active') {
        return 'closed';
    }

    if (error.status === 429) {
        return 'rate_limited';
    }

    return error.code === 'network' ? 'network' : 'unknown';
}
