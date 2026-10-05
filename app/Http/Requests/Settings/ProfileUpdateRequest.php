<?php

namespace App\Http\Requests\Settings;

use App\Concerns\ProfileValidationRules;
use App\Http\Requests\Concerns\CleansDisplayText;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

class ProfileUpdateRequest extends FormRequest
{
    use CleansDisplayText, ProfileValidationRules;

    protected function prepareForValidation(): void
    {
        $this->cleanDisplayText(['name']);
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return $this->profileRules($this->user()->id);
    }
}
