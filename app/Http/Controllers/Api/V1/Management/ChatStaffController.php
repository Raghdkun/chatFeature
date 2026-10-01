<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Models\User;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * Base of the staff chat endpoints: the signed-in staff member (the route group guarantees one with chat access).
 */
abstract class ChatStaffController extends ManagementController
{
    protected function staff(Request $request): User
    {
        $user = $this->actor($request);

        if ($user === null) {
            throw new HttpException(401);
        }

        return $user;
    }
}
