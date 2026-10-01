declare namespace App {
namespace Data {
namespace Auth {
export type AuthUserData = {
id: number,
name: string,
email: string,
avatar: string | null,
is_admin: boolean,
is_agent: boolean,
auth_source: string,
};
}
}
}
