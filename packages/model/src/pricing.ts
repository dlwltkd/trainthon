export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Placeholder rates; confirm against the provider's current pricing. */
export const DEFAULT_PRICING: Pricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
};

export function computeCost(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing = DEFAULT_PRICING,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/** No price is inferred from a model name or a different provider's rates. */
export function estimateCost(inputTokens: number, outputTokens: number, pricing?: Pricing): number | null {
  if (!pricing) return null;
  if (![pricing.inputPerMTok, pricing.outputPerMTok].every((rate) => Number.isFinite(rate) && rate >= 0)) {
    throw new Error("Model pricing must contain finite nonnegative rates");
  }
  return computeCost(inputTokens, outputTokens, pricing);
}
