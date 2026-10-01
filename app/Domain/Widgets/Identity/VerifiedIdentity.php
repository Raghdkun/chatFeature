<?php

namespace App\Domain\Widgets\Identity;

/**
 * The claims of a signed identity the widget owner vouches for. Every field is optional.
 */
final readonly class VerifiedIdentity
{
    /**
     * @param  array<string, scalar|null>  $meta
     */
    public function __construct(
        public ?string $subject = null,
        public ?string $name = null,
        public ?string $email = null,
        public ?string $phone = null,
        public array $meta = [],
    ) {}

    /**
     * @return array{sub: string|null, name: string|null, email: string|null, phone: string|null, meta: array<string, scalar|null>}
     */
    public function toArray(): array
    {
        return [
            'sub' => $this->subject,
            'name' => $this->name,
            'email' => $this->email,
            'phone' => $this->phone,
            'meta' => $this->meta,
        ];
    }
}
