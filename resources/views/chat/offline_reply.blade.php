{!! $visitorName ? __('Hello :name,', ['name' => $visitorName]) : __('Hello,') !!}

{!! $body !!}

--
{!! $agentName ? __(':agent from :widget', ['agent' => $agentName, 'widget' => $widgetName]) : $widgetName !!}
{!! __('Your ticket number: :ticket', ['ticket' => $ticketNo]) !!}
