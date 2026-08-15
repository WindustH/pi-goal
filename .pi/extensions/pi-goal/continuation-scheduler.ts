export class ContinuationScheduler {
	private generation = 0;
	private phase: "idle" | "queued" | "dispatched" = "idle";
	private goalId: string | null = null;

	request(goalId: string, dispatch: () => void): boolean {
		if (this.phase !== "idle") return false;
		const generation = this.generation;
		this.phase = "queued";
		this.goalId = goalId;
		queueMicrotask(() => {
			if (this.generation !== generation || this.phase !== "queued" || this.goalId !== goalId) return;
			this.phase = "dispatched";
			dispatch();
		});
		return true;
	}

	turnStarted(): void {
		this.cancel();
	}

	cancel(): void {
		this.generation++;
		this.phase = "idle";
		this.goalId = null;
	}

	get pending(): boolean {
		return this.phase !== "idle";
	}
}
