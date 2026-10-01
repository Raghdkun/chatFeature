<?php

namespace App\Domain\Widgets\Identity;

/** Why a signed visitor identity (HS256 JWT) was rejected. Never shown to visitors in detail; useful for logs and tests. */
enum IdentityFailure: string
{
    case NoSecret = 'no_secret';
    case Malformed = 'malformed';
    case UnsupportedAlgorithm = 'unsupported_algorithm';
    case BadSignature = 'bad_signature';
    case WrongIssuer = 'wrong_issuer';
    case MissingExpiry = 'missing_expiry';
    case Expired = 'expired';
    case ExpiryTooFar = 'expiry_too_far';
    case NotYetValid = 'not_yet_valid';
    case InvalidClaims = 'invalid_claims';
    case Replayed = 'replayed';
}
