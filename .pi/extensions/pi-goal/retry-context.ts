export type AssistantMessageSnapshot = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
};

export function isAssistantErrorMessage(message: AssistantMessageSnapshot | null | undefined): boolean {
	return message?.role === "assistant" && message.stopReason === "error";
}

export function isAssistantAbortMessage(message: AssistantMessageSnapshot | null | undefined): boolean {
	return message?.role === "assistant" && message.stopReason === "aborted";
}

export function filterAssistantErrorMessages<T extends AssistantMessageSnapshot>(messages: readonly T[]): T[] {
	return messages.filter((message) => !isAssistantErrorMessage(message));
}
