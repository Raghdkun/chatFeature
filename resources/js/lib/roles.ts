/** `is_admin` / `is_agent` are the only role flags the frontend reads (shared-props contract). */
export type RoleFlags = { is_admin?: boolean; is_agent?: boolean };

export type Role = 'admin' | 'agent' | 'none';

/** Admin wins over agent; neither means the account has no chat access. */
export function roleOf(user: RoleFlags): Role {
    if (user.is_admin) {
        return 'admin';
    }

    return user.is_agent ? 'agent' : 'none';
}
