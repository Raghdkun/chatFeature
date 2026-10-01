/**
 * The body of `POST /public/widgets/{key}/sessions`, kept inside what the server accepts (`StartSessionRequest`): an optional field
 * the server would refuse is dropped, never sent, because a 422 on a field that is not on screen cannot be fixed by the visitor.
 * The loader applies the same limits; this is the second line (a hand-built `init`, the hosted page, `identify` messages).
 */
import type {
    CreateSessionRequest,
    VisitorApiError,
    VisitorFields,
} from '@/lib/chat-api/visitor';

const EMAIL = /^(?=.{3,190}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+().\- ]{3,40}$/;
const META_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const text = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';

export function serverSafeVisitor(visitor: VisitorFields): VisitorFields {
    const out: VisitorFields = {};
    const name = text(visitor.name, 120);
    const email = text(visitor.email, 191);
    const phone = text(visitor.phone, 41);

    if (name !== '') {
        out.name = name;
    }

    if (EMAIL.test(email)) {
        out.email = email;
    }

    if (PHONE.test(phone)) {
        out.phone = phone;
    }

    if (visitor.meta !== undefined) {
        const meta: NonNullable<VisitorFields['meta']> = {};

        for (const [key, value] of Object.entries(visitor.meta).slice(0, 20)) {
            if (
                META_KEY.test(key) &&
                (typeof value !== 'string' || value.length <= 500)
            ) {
                meta[key] = value;
            }
        }

        if (Object.keys(meta).length > 0) {
            out.meta = meta;
        }
    }

    return out;
}

export function serverSafeSessionBody(
    body: CreateSessionRequest,
): CreateSessionRequest {
    const visitor =
        body.visitor === undefined ? {} : serverSafeVisitor(body.visitor);

    return {
        ...(body.identity_token === undefined
            ? {}
            : { identity_token: body.identity_token }),
        ...(Object.keys(visitor).length === 0 ? {} : { visitor }),
        page: {
            url: body.page.url.slice(0, 2048),
            title: body.page.title.slice(0, 255),
            referrer: body.page.referrer.slice(0, 2048),
        },
        locale: body.locale,
    };
}

/** The unsigned extras only: what is left when the server refuses `visitor.*`, `page.*` or `locale`. */
export function bareSessionBody(
    body: CreateSessionRequest,
): CreateSessionRequest {
    return {
        ...(body.identity_token === undefined
            ? {}
            : { identity_token: body.identity_token }),
        page: { url: '', title: '', referrer: '' },
        locale: 'en',
    };
}

/** A 422 caused only by the optional `visitor.*` / `page.*` / `locale` fields (never by a signed identity). */
export function isUnsignedFieldRefusal(error: VisitorApiError): boolean {
    const fields = Object.keys(error.details);

    return (
        error.status === 422 &&
        fields.length > 0 &&
        fields.every((field) => /^(visitor|page|locale)(\.|$)/.test(field))
    );
}
