import type { LanguageModel } from "ai";
import { withCancellation } from "./budget.js";
import { ProviderRequestError, providerStreamError } from "./provider-errors.js";

type ProviderModel = Exclude<LanguageModel, string>;
type Reply = Awaited<ReturnType<ProviderModel["doGenerate"]>>;
type Part = Reply["content"][number];
type TextPart = Extract<Part, { type: "text" | "reasoning" }>;

export interface StreamActivity {
  phase: "receiving" | "tool_input";
  outputChars: number;
  toolName?: string;
}

/** Buffer a complete response before the SDK executes tools; discard it on interruption. */
export async function generateFromStream(
  model: ProviderModel,
  params: Parameters<ProviderModel["doStream"]>[0] & { abortSignal: AbortSignal },
  onActivity: (activity: StreamActivity) => void,
): Promise<Reply> {
  const streamed = await withCancellation(model.doStream(params), params.abortSignal);
  const reader = streamed.stream.getReader();
  const content: Part[] = [];
  const blocks = new Map<string, TextPart>();
  let warnings: Reply["warnings"] = [];
  let response: Reply["response"] = streamed.response;
  let finish: Pick<Reply, "finishReason" | "usage" | "providerMetadata"> | undefined;
  let bytes = 0;
  let outputChars = 0;
  let closed = false;
  const abort = () => { void reader.cancel(params.abortSignal.reason).catch(() => undefined); };
  params.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value: part } = await withCancellation(reader.read(), params.abortSignal);
      if (done) { closed = true; break; }
      if (part.type === "error") throw providerStreamError(part.error);
      if (part.type === "stream-start") { warnings = part.warnings; continue; }
      if (part.type === "response-metadata") { const { type: _type, ...metadata } = part; response = { ...response, ...metadata }; continue; }
      if (part.type === "raw") continue;
      if (part.type === "finish") {
        const { type: _type, ...metadata } = part;
        finish = metadata;
        continue;
      }
      if (finish) throw new ProviderRequestError("Model stream continued after its completion marker.", true);
      bytes += new TextEncoder().encode(JSON.stringify(part)).byteLength;
      if (bytes > 4_000_000) throw new ProviderRequestError("Model stream exceeded the response buffer capacity.", false);
      if (part.type === "text-delta" || part.type === "tool-input-delta") outputChars += part.delta.length;
      onActivity({ phase: part.type.startsWith("tool-input") ? "tool_input" : "receiving", outputChars, ...(part.type === "tool-input-start" ? { toolName: part.toolName } : {}) });
      switch (part.type) {
        case "text-start":
        case "reasoning-start": {
          const block: TextPart = { type: part.type === "text-start" ? "text" : "reasoning", text: "", providerMetadata: part.providerMetadata };
          blocks.set(`${block.type}:${part.id}`, block);
          content.push(block);
          break;
        }
        case "text-delta":
        case "reasoning-delta":
        case "text-end":
        case "reasoning-end": {
          const kind = part.type.startsWith("text") ? "text" : "reasoning";
          const block = blocks.get(`${kind}:${part.id}`);
          if (!block) throw new ProviderRequestError("Model stream contained an unframed content block.", true);
          if ("delta" in part) block.text += part.delta;
          if (part.providerMetadata) block.providerMetadata = { ...block.providerMetadata, ...part.providerMetadata };
          break;
        }
        case "tool-call":
        case "tool-result":
        case "file":
        case "source":
          content.push(part);
          break;
      }
    }
    if (!finish || finish.finishReason === "unknown" || finish.finishReason === "error") throw new ProviderRequestError("Model stream ended without a valid completion marker.", true);
    return { content, warnings, response, request: streamed.request, ...finish };
  } finally {
    params.abortSignal.removeEventListener("abort", abort);
    if (!closed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
