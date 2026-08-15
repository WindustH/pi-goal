import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalRuntime } from "./runtime";
import { registerGoalMessageRenderer } from "./ui";

export default function piGoal(pi: ExtensionAPI): void {
	registerGoalMessageRenderer(pi);
	new GoalRuntime(pi).register();
}
