/**
 * Signed visitor identities (docs/contracts/widget-config.md, "Signed identity"): what a customer's backend does with the widget's
 * identity secret. `rotateIdentitySecret()` creates the secret (shown once), `mintIdentityToken()` signs an HS256 JWT with it that a
 * host page hands to the widget (`openCustomerSite(page, instance, { identityToken })`) or the public API (`identity_token`).
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Api } from './api';

/** `POST /widgets/{ulid}/rotate-secret`: a new identity secret (the old one stops working at once). */
export async function rotateIdentitySecret(
    api: Api,
    widgetUlid: string,
): Promise<string> {
    const result = await api.ok(
        'POST',
        `/api/v1/widgets/${widgetUlid}/rotate-secret`,
    );

    return result.data.identity_secret as string;
}

const base64url = (value: string | Buffer): string =>
    Buffer.from(value).toString('base64url');

export type IdentityClaims = {
    /** The widget's public key (`iss` must equal it). */
    key: string;
    /** The customer's own id of the visitor (`sub`): the same `sub` is the same visitor in every browser. */
    sub?: string;
    name?: string;
    email?: string;
    phone?: string;
    meta?: Record<string, string | number | boolean>;
    /** Lifetime in seconds (default 120; the server accepts at most 300). */
    ttl?: number;
    /** A single-use id: the token is accepted once per widget. Default: none. */
    jti?: string | true;
    /** Overrides for negative tests (`exp` in the past, a wrong `iss`, ...). */
    claims?: Record<string, unknown>;
};

/** An HS256 JWT in the shape `IdentityTokenVerifier` accepts. */
export function mintIdentityToken(
    secret: string,
    claims: IdentityClaims,
): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        iss: claims.key,
        iat: now,
        exp: now + (claims.ttl ?? 120),
        ...(claims.sub === undefined ? {} : { sub: claims.sub }),
        ...(claims.name === undefined ? {} : { name: claims.name }),
        ...(claims.email === undefined ? {} : { email: claims.email }),
        ...(claims.phone === undefined ? {} : { phone: claims.phone }),
        ...(claims.meta === undefined ? {} : { meta: claims.meta }),
        ...(claims.jti === undefined
            ? {}
            : { jti: claims.jti === true ? randomUUID() : claims.jti }),
        ...claims.claims,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}`;

    return `${unsigned}.${base64url(createHmac('sha256', secret).update(unsigned).digest())}`;
}
