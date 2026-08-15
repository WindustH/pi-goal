export type AssistantMessageSnapshot = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
	content?: unknown;
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

function contentBlockHasWork(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const value = block as { type?: unknown; text?: unknown };
	if (value.type === "toolCall") return true;
	return typeof value.text === "string" && value.text.trim().length > 0;
}

export function isEmptySuccessfulAssistantTurn(
	message: AssistantMessageSnapshot | null | undefined,
	toolResults: readonly unknown[] | null | undefined,
): boolean {
	if (message?.role !== "assistant") return false;
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	if (toolResults?.length) return false;
	if (typeof message.content === "string") return message.content.trim().length === 0;
	if (!Array.isArray(message.content)) return true;
	return !message.content.some(contentBlockHasWork);
}
