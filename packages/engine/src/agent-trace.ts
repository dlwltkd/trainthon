import { z } from "zod";
import { posix } from "node:path";
import type { EngineState, EventInput } from "@vouch/protocol";
import type { AgentTool } from "@vouch/model";
import { LOCAL_SKILLS, type LocalSkill } from "@vouch/skills";
import { isLocalSourcePath, type LocalWorkspace } from "@vouch/sandbox";

export interface TraceWorkspace {
  dir: string;
  files: string[];
  regressionPath?: string;
}

interface TraceOptions {
  workspace: TraceWorkspace;
  role: "red" | "blue";
  stage?: EngineState;
  skills?: readonly LocalSkill[];
  signal: AbortSignal;
  onEvent: (event: EventInput) => void;
  enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
}

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value), "use plain single-line text");
const skillSchema = z.object({ skillId: text(80), reason: text(300) }).strict();
const updateSchema = z.object({
  summary: text(500),
  nextAction: text(200),
  evidence: z.array(text(500)).max(6).describe("Exact repository-relative file paths only, for example [\"src/app.ts\"]. Use [] when empty, never [\"[]\"]. No line numbers, descriptions, or intended future reads."),
  plan: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    title: text(120),
    status: z.enum(["pending", "in_progress", "completed"]),
  }).strict()).min(1).max(6),
}).strict();

export function createAgentTrace(options: TraceOptions) {
  const observed = new Set(options.workspace.regressionPath ? [options.workspace.regressionPath] : []);
  const skills = options.skills ?? LOCAL_SKILLS;
  const files = new Set(options.workspace.files);
  let selectedSkill: string | undefined;
  let reported = false;
  const stage = options.stage ?? (options.role === "red" ? "REPRODUCE" : "PATCH");
  const context = { agentRole: options.role, stage } as const;
  const requireCall = (context?: { callId: string }): string => {
    if (!context?.callId) throw new Error("trace tools require a logged call context");
    return context.callId;
  };
  const tools: AgentTool[] = [
    {
      name: "use_skill",
      description: `Load a skill and explain its relevance. Available: ${skills.filter(skill => skill.roles.includes(options.role)).map(skill => `${skill.id}: ${skill.description}`).join("; ")}`,
      schema: skillSchema,
      execute: (args, call) => options.enqueue(() => {
        options.signal.throwIfAborted();
        const { skillId, reason } = skillSchema.parse(args);
        const callId = requireCall(call);
        const skill = skills.find(skill => skill.id === skillId);
        if (!skill || !skill.roles.includes(options.role)) throw new Error("skill is not available to this role");
        options.onEvent({ type: "skill_call", skillId, version: skill.version, reason, callId, ...context });
        selectedSkill = skillId;
        return { id: skill.id, name: skill.name, version: skill.version, instructions: skill.instructions };
      }),
    },
    {
      name: "report_progress",
      description: "Publish a short public decision summary, next action, observed repository evidence paths and up to six plan steps. Start with evidence: [] before reading files; files you intend to read belong in nextAction or plan, not evidence. After successful reads, searches or edits, those paths may be cited. Use at meaningful decisions, before edits, and before finishing. At most one step may be in_progress. This is a user-facing summary, not private internal reasoning.",
      schema: updateSchema,
      execute: (args, call) => options.enqueue(() => {
        options.signal.throwIfAborted();
        const update = updateSchema.parse(args);
        update.evidence = update.evidence.map(path => posix.normalize(path));
        const callId = requireCall(call);
        if (!selectedSkill) throw new Error("call use_skill before publishing a plan");
        if (new Set(update.plan.map(step => step.id)).size !== update.plan.length) throw new Error("plan step IDs must be unique");
        if (update.plan.filter(step => step.status === "in_progress").length > 1) throw new Error("only one plan step may be in progress");
        for (const path of update.evidence) {
          if (!files.has(path) || !observed.has(path)) {
            throw new Error(`Evidence must reference an observed repository file: ${path}. Use exact paths only, without descriptions. Retry report_progress with an empty evidence array to record your plan, then read the files. Put intended reads in nextAction or plan.${options.workspace.regressionPath ? ` The supplied regression (${options.workspace.regressionPath}) may also be cited.` : ""}`);
          }
        }
        options.onEvent({ type: "agent_update", ...update, callId, ...context });
        reported = true;
        return { recorded: true, callId };
      }),
    },
  ];
  return {
    tools,
    activeSkill: () => selectedSkill,
    assertEvidence(paths: string[]) {
      if (!paths.length) throw new Error("at least one observed source file is required");
      for (const path of paths) {
        if (!files.has(path) || !observed.has(path)) throw new Error(`evidence is not an observed file: ${path}`);
      }
    },
    observe(paths: string[], created = false) {
      for (const input of paths) {
        const path = posix.normalize(input);
        if (created && "protectedPaths" in options.workspace && isLocalSourcePath(options.workspace as LocalWorkspace, path)) files.add(path);
        if (files.has(path)) observed.add(path);
      }
    },
    requireReady() {
      if (!selectedSkill || !reported) throw new Error("call use_skill and report_progress before repository tools");
    },
  };
}

export type AgentTrace = ReturnType<typeof createAgentTrace>;
