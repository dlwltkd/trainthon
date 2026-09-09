import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationCase } from "@vouch/protocol";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const COHORT_URL = "https://raw.githubusercontent.com/secureIT-project/CVEfixes/9283b50b3f04e3c5b0a17fc419ab0feea23fc438/Examples/custom.json";

const pairs = [
  {
    cve: "CVE-2016-9964", cwe: "CWE-93",
    before: "58882c718889533e2f848b70d9733c1474f8ed44", fixed: "6d7e13da0f998820800ecb3fe9ccee4189aefb54",
    beforeHash: "bb8a0edc0eb2bb90337dadb33265706d05e57393dcb7d56c93bbb9b15d87c586",
    fixedHash: "ff55e7f52c3a9310ac3c65949210fc82e5564ebf8f256caf1d1f33f69ed4484d",
    area: "HeaderDict and the header name/value normalization helpers",
    question: "Does this source consistently reject forbidden line separators in HTTP header names and values at the normalization boundary?",
  },
  {
    cve: "CVE-2022-31799", cwe: "CWE-755",
    before: "e1be22df61b9d545b7af3d8990603f4782eecced", fixed: "e140e1b54da721a660f2eb9d58a106b7b3ff2f00",
    beforeHash: "498a2e1323fc89bd8d2da901a7611dce7b8b596ec0690940f3733e323a921e2a",
    fixedHash: "229ec31d3dde00d6dca0d4a920c312e71a99042c0d429b25236aaf549563b676",
    area: "Bottle._handle and its request-path decoding and exception handling",
    question: "Does the request-path decoding failure receive a controlled HTTP error through the framework's exception-handling boundary?",
  },
] as const;

export const VERDICT_INSTRUCTION = 'Finish with ONLY a JSON object: {"verdict":"issue_present"|"issue_absent"|"uncertain","summary":"brief source-based explanation","evidence":[{"path":"bottle.py","quote":"an exact nonempty excerpt of the ORIGINAL source supporting the verdict"}]}. Do not include any other issue in this verdict.';

export function evaluationCases(): EvaluationCase[] {
  return pairs.flatMap((pair, index) => (["before", "fixed"] as const).map((variant, variantIndex) => ({
    id: `sample-${index * 2 + variantIndex + 1}`,
    cve: pair.cve, cwe: pair.cwe, variant,
    sourceUrl: `https://raw.githubusercontent.com/bottlepy/bottle/${pair[variant]}/bottle.py`,
    sourceSha256: variant === "before" ? pair.beforeHash : pair.fixedHash,
    referenceUrl: `https://raw.githubusercontent.com/bottlepy/bottle/${pair.fixed}/bottle.py`,
    referenceSha256: pair.fixedHash,
    prompt: `Perform a passive source review and propose a minimal repair only if needed for ${pair.cwe}. Scope: bottle.py, ${pair.area}. ${pair.question}\nThe snapshot may already contain the relevant correction. Review only this concern. Read the relevant source, explain your decision, and preserve unrelated behavior. Do not run the code, create attack inputs, reproduce the issue, use network tools, or look up known patches. If the concern is present, propose the smallest source correction. If it is absent, leave the source unchanged.\n${VERDICT_INSTRUCTION}`,
  })));
}

export async function prepareEvaluationSources(cacheDir: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  for (const task of evaluationCases()) {
    const path = join(cacheDir, `${task.sourceSha256}.py`);
    if (existsSync(path) && sha256(readFileSync(path)) === task.sourceSha256) continue;
    const response = await fetch(task.sourceUrl, { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), redirect: "error" });
    if (!response.ok) throw new Error(`source download failed: HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error("source download has no body");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 400_000) throw new Error("source snapshot exceeds 400 KB");
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (sha256(content) !== task.sourceSha256) throw new Error(`pinned source hash mismatch: ${task.id}`);
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}
