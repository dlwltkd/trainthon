export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal)) {
      const existing = target[key];
      if (typeof existing !== "object" || existing === null) {
        target[key] = {};
      }
      deepMerge(
        target[key] as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}
