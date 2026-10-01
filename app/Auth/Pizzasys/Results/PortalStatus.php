<?php

namespace App\Auth\Pizzasys\Results;

/** Outcome class of one call to the auth portal. */
enum PortalStatus: string
{
    /** The call worked (valid credentials / an active token). */
    case Ok = 'ok';

    /** `token-verify` answered HTTP 200 `active:false`, or `/auth/me` answered 401: the user token is dead. */
    case Inactive = 'inactive';

    /** The user's credentials were refused (login 401 / 422). */
    case Invalid = 'invalid';

    /** `token-verify` answered HTTP 401: OUR service credential is wrong, expired or deactivated. */
    case ServiceRejected = 'service_rejected';

    /** Timeout, connection error, 5xx, rate limiting, an open circuit breaker or an unreadable answer. */
    case Unavailable = 'unavailable';
}
