export const STATE_ENTRY_TYPE = "pi-goal";
export const TRIGGER_MESSAGE_TYPE = "pi-goal-event";
export const STATUS_KEY = "pi-goal";
export const WIDGET_KEY = "Goal";
export const TRIGGER_TEXT = "Continue the active goal from the current state.";

export type GoalPreferences = {
	statusBarEnabled: boolean;
	widgetEnabled: boolean;
};

export const DEFAULT_PREFERENCES: GoalPreferences = {
	statusBarEnabled: true,
	widgetEnabled: true,
};
