<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Models\User;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * Base of the WhatsApp management endpoints. The route group is `auth:sanctum`, `session.valid`, `chat.access`, `wa.admin`: only an
 * active administrator ever gets here, and every action asks `WhatsAppPolicy` again.
 */
abstract class WhatsAppController extends ManagementController
{
    protected function admin(Request $request): User
    {
        $user = $this->actor($request);

        if ($user === null) {
            throw new HttpException(401);
        }

        return $user;
    }
}
