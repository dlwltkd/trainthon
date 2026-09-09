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
