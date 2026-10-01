import { describe, expect, it } from 'vite-plus/test';
import {
    fieldErrorsOf,
    toCreateFailure,
    toNotice,
} from '@/embed/session/errors';
import { VisitorApiError } from '@/lib/chat-api/visitor';

const error = (
    status: number,
    code: string,
    details?: Record<string, string[]>,
    retryAfter?: number,
) => new VisitorApiError({ status, code, message: code, details, retryAfter });

describe('error mapping', () => {
    it('maps API failures to notices', () => {
        expect(toNotice(error(429, 'rate_limited', undefined, 12))).toEqual({
            code: 'rate_limited',
            seconds: 12,
        });
        expect(toNotice(error(429, 'rate_limited'))).toEqual({
            code: 'rate_limited',
            seconds: 5,
        });
        expect(toNotice(error(0, 'network'))).toEqual({ code: 'network' });
        expect(toNotice(error(404, 'widget_not_found'))).toEqual({
            code: 'unavailable',
        });
        expect(toNotice(error(403, 'origin_not_allowed'))).toEqual({
            code: 'unavailable',
        });
        expect(toNotice(error(401, 'session_revoked'))).toEqual({
            code: 'session_expired',
        });
        expect(toNotice(error(500, 'server_error'))).toEqual({
            code: 'generic',
        });
        expect(toNotice(error(403, 'feature_disabled'))).toEqual({
            code: 'feature_disabled',
        });
        expect(toNotice(new Error('boom'))).toEqual({ code: 'generic' });
    });

    it('a signed identity the server refuses is its own notice, not a form field error', () => {
        const refused = error(422, 'validation_failed', {
            identity_token: ['The identity could not be verified.'],
        });

        expect(refused.isIdentityRejected).toBe(true);
        expect(toNotice(refused)).toEqual({ code: 'identity' });
        expect(toCreateFailure(refused)).toEqual({
            kind: 'notice',
            notice: { code: 'identity' },
        });
        expect(
            error(422, 'validation_failed', { email: ['Bad'] })
                .isIdentityRejected,
        ).toBe(false);
    });

    it('flattens field errors (dotted names included), first message wins', () => {
        expect(
            fieldErrorsOf(
                error(422, 'validation_failed', {
                    'visitor.name': ['Name!'],
                    email: ['One', 'Two'],
                    name: ['Other'],
                }),
            ),
        ).toEqual({ name: 'Name!', email: 'One' });
    });

    it('classifies a failed start', () => {
        expect(toCreateFailure(error(409, 'no_agents'))).toEqual({
            kind: 'no_agents',
        });
        expect(
            toCreateFailure(
                error(422, 'validation_failed', { email: ['Bad'] }),
            ),
        ).toEqual({
            kind: 'validation',
            errors: { email: 'Bad' },
        });
        expect(toCreateFailure(error(422, 'validation_failed'))).toEqual({
            kind: 'notice',
            notice: { code: 'generic' },
        });
        expect(
            toCreateFailure(error(429, 'rate_limited', undefined, 3)),
        ).toEqual({
            kind: 'notice',
            notice: { code: 'rate_limited', seconds: 3 },
        });
        expect(toCreateFailure('weird')).toEqual({
            kind: 'notice',
            notice: { code: 'generic' },
        });
    });
});
