import type { Budgets } from "@vouch/protocol";

export class BudgetExceededError extends Error {
  constructor(readonly reason: "tokens" | "steps" | "wall") {
    super(`Run ${reason} budget exhausted`);
    this.name = "BudgetExceededError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunBudget {
  private readonly startedAt = performance.now();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly totals = { inputTokens: 0, outputTokens: 0, steps: 0 };
  private reservedTokens = 0;
  private completeUsage = true;
  private readonly onExternalAbort = () => this.controller.abort(new RunCancelledError());
  readonly limits: Readonly<Budgets>;

  constructor(
    limits: Budgets,
    private readonly externalSignal?: AbortSignal,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    this.limits = Object.freeze({ ...limits });
    this.timer = setTimeout(() => this.controller.abort(new BudgetExceededError("wall")), this.limits.maxWallMs);
    externalSignal?.addEventListener("abort", this.onExternalAbort, { once: true });
    if (externalSignal?.aborted) this.onExternalAbort();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get elapsedMs(): number { return Math.floor(performance.now() - this.startedAt); }
  get remainingTokens(): number {
    return Math.max(0, this.limits.maxTokens - this.totals.inputTokens - this.totals.outputTokens - this.reservedTokens);
  }
  get remainingSteps(): number { return Math.max(0, this.limits.maxSteps - this.totals.steps); }
  get usage(): Readonly<typeof this.totals> { return { ...this.totals }; }
  get usageKnown(): boolean { return this.completeUsage; }

  /** Check cancellation and wall time while completing an already-counted step. */
  assertActive(): void {
    if (this.elapsedMs >= this.limits.maxWallMs && !this.signal.aborted) {
      this.controller.abort(new BudgetExceededError("wall"));
    }
    if (this.signal.aborted) throw this.signal.reason;
  }

  /** Check before starting another model step or role. */
  check(): void {
    this.assertActive();
    const reason = this.remainingTokens === 0 ? "tokens" : this.remainingSteps === 0 ? "steps" : null;
    if (reason) {
      const error = new BudgetExceededError(reason);
      this.controller.abort(error);
      throw error;
    }
  }

  /** Reject a request before dispatch unless its conservative token allowance fits. */
  requireTokens(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new Error("A token allowance must be a positive safe integer");
    }
    this.check();
    if (tokens <= this.remainingTokens) return;
    const error = new BudgetExceededError("tokens");
    this.controller.abort(error);
    throw error;
  }

  /** Hold capacity for an in-flight provider request without changing reported usage. */
  reserveTokens(tokens: number): () => void {
    this.requireTokens(tokens);
    this.reservedTokens += tokens;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.reservedTokens -= tokens;
    };
  }

  /** Provider usage may exceed the remaining budget; retain the full amount. */
  consumeStep(inputTokens: number, outputTokens: number): void {
    this.recordTokens(inputTokens, outputTokens);
    this.totals.steps++;
  }

  /** Add usage to a step reserved before sending a provider request. */
  recordTokens(inputTokens: number, outputTokens: number): void {
    if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Token usage must contain nonnegative safe integers");
    }
    this.totals.inputTokens += inputTokens;
    this.totals.outputTokens += outputTokens;
  }

  markUsageUnknown(): void {
    this.completeUsage = false;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }
}

/** Providers and scripts that ignore AbortSignal still yield control promptly. */
export async function withCancellation<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new RunCancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
