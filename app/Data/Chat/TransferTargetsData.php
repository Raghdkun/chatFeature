<?php

namespace App\Data\Chat;

use Spatie\LaravelData\Attributes\DataCollectionOf;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Where an active live chat can be handed to (`GET /conversations/{ulid}/transfer-targets`): the active agents who serve its
 * category (not the caller, not the agent who has it) with their presence and load, and the categories of its widget that
 * currently have at least one reachable agent other than those two (not the chat's own category).
 */
#[TypeScript]
class TransferTargetsData extends Data
{
    /**
     * @param  list<TransferAgentData>  $agents
     * @param  list<CategoryRefData>  $categories
     */
    public function __construct(
        #[DataCollectionOf(TransferAgentData::class)]
        public array $agents,
        #[DataCollectionOf(CategoryRefData::class)]
        public array $categories,
    ) {}
}
