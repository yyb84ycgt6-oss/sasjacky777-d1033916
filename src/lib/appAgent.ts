/**
 * An agent inside the app that can act on it, not only talk.
 *
 * The Agent Lab's agents could answer; they could not do anything. This gives
 * any of them — DeepSeek, Hermes, or whatever else is loaded — the same actions
 * an external harness gets through the MCP server (`appActions.ts`), in a loop:
 * the model names one action, the app runs it as the signed-in user, the result
 * goes back to the model, and so on until it answers.
 *
 * The action format is plain text rather than a provider's native tool-calling,
 * because the same agent has to work on DeepSeek's API, on OpenRouter, on LM
 * Studio and on Ollama, and those do not agree on a tool-calling wire format —
 * several local servers do not support one at all. Two shapes are understood:
 *
 *   ```action
 *   {"tool": "create_task", "args": {"title": "…"}}
 *   ```
 *
 * and Hermes's own trained format,
 *
 *   <tool_call>{"name": "create_task", "arguments": {"title": "…"}}</tool_call>
 *
 * so a Hermes model can act in the format it was tuned on. Reasoning models
 * (DeepSeek R1) wrap their thinking in <think>…</think>; that is stripped before
 * parsing and from the final answer.
 *
 * Nothing here touches the network or the database directly: the model call
 * and the action executor are injected, which is what lets the loop be tested
 * exactly as it runs.
 */
import {
  MEMORY_CATEGORIES, TASK_PRIORITIES, TASK_STATUSES, type ActionResult,
} from "./appActions";

export interface AgentTool {
  name: string;
  /** One line for the model. */
  description: string;
  /** Argument shape, written the way a model reads it. */
  args: string;
  /** Deletes something. Off unless the agent was allowed to. */
  destructive?: boolean;
}

export const AGENT_TOOLS: readonly AgentTool[] = [
  { name: "list_tasks", description: "List the user's tasks, newest first.", args: `{"status"?: ${TASK_STATUSES.map((s) => `"${s}"`).join("|")}, "limit"?: number}` },
  { name: "create_task", description: "Create a task on the user's task board.", args: `{"title": string, "description"?: string, "priority"?: ${TASK_PRIORITIES.map((s) => `"${s}"`).join("|")}, "due_date"?: "YYYY-MM-DD"}` },
  { name: "update_task", description: "Change a task. Give only the fields to change.", args: `{"id": string, "status"?: ${TASK_STATUSES.map((s) => `"${s}"`).join("|")}, "priority"?: string, "title"?: string, "description"?: string, "due_date"?: string}` },
  { name: "delete_task", description: "Permanently delete a task. Prefer update_task with status \"done\".", args: `{"id": string}`, destructive: true },
  { name: "search_memory", description: "Search Jackie's long-term memory. Omit query to list recent entries.", args: `{"query"?: string, "category"?: ${MEMORY_CATEGORIES.map((s) => `"${s}"`).join("|")}, "limit"?: number}` },
  { name: "remember_fact", description: "Store or overwrite a fact Jackie will see in every chat.", args: `{"key": string, "value": string, "category"?: ${MEMORY_CATEGORIES.map((s) => `"${s}"`).join("|")}}` },
  { name: "forget_fact", description: "Delete a memory entry by id or key.", args: `{"id"?: string, "key"?: string}`, destructive: true },
  { name: "list_conversations", description: "List the user's chat conversations.", args: `{"limit"?: number}` },
  { name: "read_conversation", description: "Read a conversation's recent messages.", args: `{"id": string, "limit"?: number}` },
];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/** The instructions appended to an acting agent's own system prompt. */
export function actionManual(allowDestructive: boolean): string {
  const tools = AGENT_TOOLS.filter((t) => allowDestructive || !t.destructive)
    .map((t) => `- ${t.name} ${t.args} — ${t.description}`)
    .join("\n");
  return [
    "## Acting on the app",
    "You can act on the user's Jackie app. To use an action, reply with ONE block and nothing after it:",
    "```action",
    '{"tool": "<name>", "args": { ... }}',
    "```",
    "The app runs it and replies with the result. Use one action per reply; wait for its result before the next.",
    "When you are finished, reply normally with no action block — that reply is your final answer to the user.",
    "Never claim you did something unless an action result confirmed it. If an action fails, say so.",
    "",
    "Actions:",
    tools,
  ].join("\n");
}

export type ParsedAction =
  | { kind: "action"; tool: string; args: Record<string, unknown> }
  | { kind: "malformed"; reason: string }
  | { kind: "none" };

/** Removes `<think>…</think>` blocks, including an unterminated one at the start. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*<think>[\s\S]*$/i, "").trim();
}

function asArgs(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    try {
      return asArgs(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Finds the one action a reply asks for, if any. */
export function parseAction(reply: string): ParsedAction {
  const text = stripThinking(reply);
  const fenced = /```(?:action|json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const hermes = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text);
  const raw = hermes?.[1] ?? fenced?.[1];
  if (!raw) return { kind: "none" };

  let body: unknown;
  try {
    body = JSON.parse(raw.trim());
  } catch {
    // A fenced block that is not JSON is ordinary prose with code in it, not
    // an attempted action — unless it was explicitly marked as one.
    return hermes || /```action/i.test(text)
      ? { kind: "malformed", reason: "the action block is not valid JSON" }
      : { kind: "none" };
  }
  if (!body || typeof body !== "object") return { kind: "malformed", reason: "the action is not an object" };
  const obj = body as Record<string, unknown>;
  const tool = typeof obj.tool === "string" ? obj.tool : typeof obj.name === "string" ? obj.name : "";
  if (!tool) {
    return fenced && !hermes && !/```action/i.test(text)
      ? { kind: "none" } // a JSON code sample, not an action
      : { kind: "malformed", reason: 'the action names no "tool"' };
  }
  const args = asArgs(obj.args ?? obj.arguments);
  if (!args) return { kind: "malformed", reason: `the arguments for ${tool} are not an object` };
  return { kind: "action", tool, args };
}

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  result: ActionResult;
}

export type ModelTurn = { role: "user" | "assistant"; content: string };

export interface RunAppAgentOptions {
  /** The agent's own system prompt; the action manual is appended to it. */
  system: string;
  prompt: string;
  /** One model call. Resolves to the reply text, or says why there is none. */
  callModel: (messages: ModelTurn[], system: string) => Promise<ActionResult<string>>;
  /** Runs one action as the signed-in user. */
  execute: (tool: string, args: Record<string, unknown>) => Promise<ActionResult>;
  allowDestructive?: boolean;
  /**
   * False runs a plain answer through the same model path — for an agent on a
   * local server with app control off. It is not told about actions, and its
   * reply is the answer whatever it contains.
   */
  canAct?: boolean;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void;
  signal?: AbortSignal;
}

export interface AgentRun {
  ok: boolean;
  /** The final answer, when there is one. */
  answer: string;
  steps: AgentStep[];
  error?: string;
}

const RESULT_CHARS = 4_000;

export async function runAppAgent(opts: RunAppAgentOptions): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 6;
  const allowDestructive = opts.allowDestructive ?? false;
  const canAct = opts.canAct ?? true;
  const system = canAct ? `${opts.system.trim()}\n\n${actionManual(allowDestructive)}` : opts.system.trim();
  const messages: ModelTurn[] = [{ role: "user", content: opts.prompt }];
  const steps: AgentStep[] = [];

  for (let turn = 0; turn <= maxSteps; turn++) {
    if (opts.signal?.aborted) return { ok: false, answer: "", steps, error: "Stopped." };

    const reply = await opts.callModel(messages, system);
    if (!reply.ok) return { ok: false, answer: "", steps, error: reply.error };

    const parsed: ParsedAction = canAct ? parseAction(reply.data) : { kind: "none" };
    if (parsed.kind === "none") {
      const answer = stripThinking(reply.data);
      return answer
        ? { ok: true, answer, steps }
        : { ok: false, answer: "", steps, error: "The model finished without an answer." };
    }

    if (turn === maxSteps) break;
    messages.push({ role: "assistant", content: reply.data });

    let result: ActionResult;
    let step: AgentStep;
    if (parsed.kind === "malformed") {
      result = { ok: false, error: `Could not read your action: ${parsed.reason}. Reply with one valid action block.` };
      step = { tool: "(unreadable)", args: {}, result };
    } else {
      const tool = findAgentTool(parsed.tool);
      result = !tool
        ? { ok: false, error: `There is no action called "${parsed.tool}".` }
        : tool.destructive && !allowDestructive
        ? { ok: false, error: `${tool.name} is turned off for this agent: it deletes things, and deletes were not allowed.` }
        : await opts.execute(tool.name, parsed.args);
      step = { tool: parsed.tool, args: parsed.args, result };
    }
    steps.push(step);
    opts.onStep?.(step);

    const shown = result.ok ? JSON.stringify(result.data) : `ERROR: ${result.error}`;
    messages.push({
      role: "user",
      content: `Result of ${step.tool}:\n${shown.length > RESULT_CHARS ? `${shown.slice(0, RESULT_CHARS)}… (truncated)` : shown}`,
    });
  }

  // Said plainly, because the alternative — returning the last action as if it
  // were an answer — reports work as finished when it was cut short (rule 8).
  return {
    ok: false,
    answer: "",
    steps,
    error: `Stopped after ${maxSteps} actions without a final answer. The actions above did run.`,
  };
}
