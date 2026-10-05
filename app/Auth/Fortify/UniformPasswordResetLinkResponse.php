<?php

namespace App\Auth\Fortify;

use Illuminate\Support\Facades\Password;
use Laravel\Fortify\Contracts\FailedPasswordResetLinkRequestResponse;
use Laravel\Fortify\Http\Responses\SuccessfulPasswordResetLinkRequestResponse;

/**
 * "Forgot password" answers the SAME for every address: Fortify's own failure ("We can't find a user with that email address", and the
 * "Please wait before retrying" of an address that already asked) tells a stranger which addresses have an account, which the sign-in
 * form takes care not to do. The mail itself is only sent to a real account. (Fortify builds this with the broker's status as a constructor
 * argument; there is deliberately no constructor: what the broker said is never looked at.)
 */
final class UniformPasswordResetLinkResponse implements FailedPasswordResetLinkRequestResponse
{
    public function toResponse($request)
    {
        return (new SuccessfulPasswordResetLinkRequestResponse(Password::RESET_LINK_SENT))->toResponse($request);
    }
}
