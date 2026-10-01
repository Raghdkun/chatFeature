<?php

namespace App\Auth\Pizzasys\Results;

/**
 * What the portal vouches for about one user token (canonical identity + global roles/permissions).
 * `ext.*` of the verify payload is deliberately ignored.
 */
final readonly class PortalClaims
{
    /**
     * @param  list<string>  $roles
     * @param  list<string>  $permissions
     */
    public function __construct(
        public string $sub,
        public string $name,
        public string $email,
        public array $roles = [],
        public array $permissions = [],
        public ?int $exp = null,
    ) {}

    /**
     * From a `POST /auth/token-verify` answer with `active: true`.
     *
     * @param  array<array-key, mixed>  $body
     */
    public static function fromVerifyPayload(array $body): ?self
    {
        $user = is_array($body['user'] ?? null) ? $body['user'] : [];
        $sub = $body['sub'] ?? $user['id'] ?? null;
        $email = $user['email'] ?? null;

        if ((! is_string($sub) && ! is_int($sub)) || (string) $sub === '' || ! is_string($email) || $email === '') {
            return null;
        }

        $name = is_string($user['name'] ?? null) && $user['name'] !== '' ? $user['name'] : $email;

        return new self(
            (string) $sub,
            $name,
            $email,
            self::names($body['roles'] ?? []),
            self::names($body['permissions'] ?? []),
            is_int($body['exp'] ?? null) ? $body['exp'] : null,
        );
    }

    /**
     * From a `GET /auth/me` answer: the global roles plus every permission they carry plus direct global
     * permissions. Store-scoped permissions (`all_permissions`) are NOT global and are ignored, exactly like
     * `token-verify` does.
     *
     * @param  array<array-key, mixed>  $body
     */
    public static function fromMePayload(array $body): ?self
    {
        $data = is_array($body['data'] ?? null) ? $body['data'] : [];
        $user = is_array($data['user'] ?? null) ? $data['user'] : [];
        $id = $user['id'] ?? null;
        $email = $user['email'] ?? null;

        if ((! is_string($id) && ! is_int($id)) || (string) $id === '' || ! is_string($email) || $email === '') {
            return null;
        }

        $roles = [];
        $permissions = self::names($user['global_permissions'] ?? []);

        foreach (is_array($user['global_roles'] ?? null) ? $user['global_roles'] : [] as $role) {
            if (! is_array($role)) {
                continue;
            }

            if (is_string($role['name'] ?? null)) {
                $roles[] = $role['name'];
            }

            $permissions = [...$permissions, ...self::names($role['permissions'] ?? [])];
        }

        return new self(
            (string) $id,
            is_string($user['name'] ?? null) && $user['name'] !== '' ? $user['name'] : $email,
            $email,
            array_values(array_unique($roles)),
            array_values(array_unique($permissions)),
        );
    }

    /**
     * @param  array<array-key, mixed>  $data
     */
    public static function fromArray(array $data): ?self
    {
        if (! is_string($data['sub'] ?? null) || ! is_string($data['name'] ?? null) || ! is_string($data['email'] ?? null)) {
            return null;
        }

        return new self(
            $data['sub'],
            $data['name'],
            $data['email'],
            self::names($data['roles'] ?? []),
            self::names($data['permissions'] ?? []),
            is_int($data['exp'] ?? null) ? $data['exp'] : null,
        );
    }

    /**
     * @return array{sub: string, name: string, email: string, roles: list<string>, permissions: list<string>, exp: int|null}
     */
    public function toArray(): array
    {
        return [
            'sub' => $this->sub,
            'name' => $this->name,
            'email' => $this->email,
            'roles' => $this->roles,
            'permissions' => $this->permissions,
            'exp' => $this->exp,
        ];
    }

    /**
     * A list of names from either `["a","b"]` or `[{"name":"a"}]`.
     *
     * @return list<string>
     */
    private static function names(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $names = [];

        foreach ($value as $item) {
            $name = is_array($item) ? ($item['name'] ?? null) : $item;

            if (is_string($name) && $name !== '') {
                $names[] = $name;
            }
        }

        return array_values(array_unique($names));
    }
}
