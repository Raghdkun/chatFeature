<?php

namespace App\Domain\Install\Support;

/** One row of the wizard's environment check. */
final readonly class EnvironmentCheck
{
    public function __construct(
        public string $key,
        public string $label,
        public bool $ok,
        public ?string $message = null,
        public bool $optional = false,
    ) {}

    /**
     * @return array{key: string, label: string, ok: bool, message?: string}
     */
    public function toArray(bool $withMessage = true): array
    {
        $row = ['key' => $this->key, 'label' => $this->label, 'ok' => $this->ok];

        if ($withMessage && $this->message !== null) {
            $row['message'] = $this->message;
        }

        return $row;
    }
}
