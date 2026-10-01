<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Catalog\Actions\EnsureGeneralCategory;
use App\Domain\Install\Contracts\SeedsDefaults;
use App\Domain\Install\InstallContext;
use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Support\WidgetKeyGenerator;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;

/**
 * Install seeder: one DISABLED sample widget with the default config, three greetings and the "General" category,
 * so the dashboard has something to open. Idempotent: nothing happens when any widget already exists
 * (also one an admin deleted: the seeder only ever runs on a fresh installation).
 */
final class SeedSampleWidget implements SeedsDefaults
{
    /** @var list<array{body: string, agent_name: string|null}> */
    private const GREETINGS = [
        ['body' => 'Hi there! Got a question? We are here to help.', 'agent_name' => 'Sara'],
        ['body' => 'Welcome! Ask us anything. We usually reply within a few minutes.', 'agent_name' => 'Omar'],
        ['body' => 'Not sure where to start? Tell us what you need and we will point you in the right direction.', 'agent_name' => null],
    ];

    public function __construct(private readonly EnsureGeneralCategory $general) {}

    public function seed(InstallContext $context): void
    {
        $category = $this->general->ensure();

        if (Widget::withTrashed()->exists()) {
            return;
        }

        DB::transaction(function () use ($category): void {
            $config = (new WidgetConfigData)->toArray();

            $widget = new Widget(['name' => 'Sample widget']);
            $widget->forceFill([
                'public_key' => WidgetKeyGenerator::generate(),
                'config' => $config,
                'draft_config' => $config,
                'config_version' => 1,
                'is_enabled' => false,
            ])->save();

            $widget->categories()->attach($category->id, ['sort_order' => 0]);

            foreach (self::GREETINGS as $position => $greeting) {
                $widget->greetings()->create([
                    'body' => $greeting['body'],
                    'agent_name' => $greeting['agent_name'],
                    'weight' => 1,
                    'is_active' => true,
                    'sort_order' => $position,
                ]);
            }
        });
    }
}
