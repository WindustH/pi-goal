import { TRIGGER_MESSAGE_TYPE, TRIGGER_TEXT } from "./constants";
import { isAssistantErrorMessage, type AssistantMessageSnapshot } from "./retry-context";

export type ContextMessageSnapshot = AssistantMessageSnapshot & {
	customType?: string;
	content?: unknown;
	details?: unknown;
};

function goalIdFromTrigger(message: ContextMessageSnapshot): string | null {
	if (message.customType !== TRIGGER_MESSAGE_TYPE) return null;
	const details = message.details as { goal?: { id?: unknown } } | undefined;
	return typeof details?.goal?.id === "string" ? details.goal.id : null;
}

export function filterProviderContext<T extends ContextMessageSnapshot>(
	messages: readonly T[],
	activeGoalId: string | null,
): T[] {
	let newestActiveTrigger = -1;
	if (activeGoalId) {
		for (let index = messages.length - 1; index >= 0; index--) {
			if (goalIdFromTrigger(messages[index]) === activeGoalId) {
				newestActiveTrigger = index;
				break;
			}
		}
	}

	const filtered: T[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (isAssistantErrorMessage(message)) continue;
		if (message.customType === TRIGGER_MESSAGE_TYPE) {
			if (index !== newestActiveTrigger) continue;
			filtered.push({ ...message, content: TRIGGER_TEXT } as T);
			continue;
		}
		filtered.push(message);
	}
	return filtered;
}
