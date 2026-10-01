<?php

namespace App\Http\Requests\Chat;

use Illuminate\Foundation\Http\FormRequest;

/** Body of `POST .../receipts`: the highest message number (`seq`) delivered and/or seen; at least one is required. */
class ReceiptsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'delivered_upto' => ['nullable', 'integer', 'min:0', 'max:2147483647', 'required_without:seen_upto'],
            'seen_upto' => ['nullable', 'integer', 'min:0', 'max:2147483647', 'required_without:delivered_upto'],
        ];
    }

    public function deliveredUpto(): ?int
    {
        $value = $this->validated('delivered_upto');

        return $value === null ? null : (int) $value;
    }

    public function seenUpto(): ?int
    {
        $value = $this->validated('seen_upto');

        return $value === null ? null : (int) $value;
    }
}
