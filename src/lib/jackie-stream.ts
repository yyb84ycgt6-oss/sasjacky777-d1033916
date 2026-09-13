/**
 * The browser half of Jackie's chat.
 *
 * This reads a Server-Sent Events stream from the `jackie-chat` edge function
 * and hands each token to the caller. Three things it did not do are the
 * reason a broken chat looked like a working one:
 *
 * 1. **An error inside the stream was dropped on the floor.** The gateway can
 *    answer 200 and then put the failure in the body — a filtered prompt, a
 *    model that went away mid-answer. The parser only looked at
 *    `choices[0].delta.content` and ignored every other frame, so those became
 *    an empty assistant bubble and nothing else. There was nothing to read and
 *    nothing in the console.
 *
 * 2. **A stream that carried no content at all still reported success.** The
 *    caller saved an empty message and Jackie appeared to have answered with
 *    silence. Silence is now an error with a name.
 *
 * 3. **A send could not be stopped.** Once a request was in flight the UI was
 *    locked until it finished, which on a slow or wedged model meant the chat
 *    was simply unusable until the tab was reloaded.
 *
 * The model list lives in `supabase/functions/_shared/chatRequest.ts` and is
 * imported from there by both this file and the function, so the picker cannot
 * offer something the server will reject.
 */
import { callEdgeFunction, describeEdgeFailure } from "@/lib/edgeFunction";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "../../supabase/functions/_shared/chatRequest";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** The models the picker offers — the same list the function accepts. */
export const JACKIE_MODELS = CHAT_MODELS;

export type JackieModelId = string;

export { DEFAULT_CHAT_MODEL };

/** True when `id` is a model this build still knows about. */
export function isKnownModel(id: unknown): id is JackieModelId {
  return typeof id === "string" && CHAT_MODELS.some((m) => m.id === id);
}

/**
 * Reads one SSE frame's JSON for either a token or a failure.
 *
 * OpenAI-compatible gateways are not consistent about where a mid-stream error
 * goes: some send `{"error": {...}}`, some `{"error": "..."}`, some put a
 * `finish_reason` like `content_filter` on the choice and no content at all.
 * All three used to be silently discarded.
 */
function readFrame(parsed: unknown): { content?: string; error?: string } {
  if (!parsed || typeof parsed !== "object") return {};
  const frame = parsed as {
    error?: unknown;
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  };

  if (frame.error) {
    const e = frame.error as { message?: unknown };
    const message = typeof e?.message === "string" ? e.message : String(frame.error);
    return { error: message };
  }

  const choice = frame.choices?.[0];
  const content = choice?.delta?.content;

  const finish = choice?.finish_reason;
  if (finish === "content_filter") {
    return { error: "The model stopped: that request tripped its content filter." };
  }

  return typeof content === "string" && content.length > 0 ? { content } : {};
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  model?: JackieModelId;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  context?: string;
  /** Abort an answer in flight. Aborting calls neither `onDone` nor `onError`. */
  signal?: AbortSignal;
}

export async function streamChat({
  messages,
  model,
  onDelta,
  onDone,
  onError,
  context,
  signal,
}: StreamChatOptions) {
  let settled = false;
  const finishWith = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  try {
    const resp = await callEdgeFunction(
      "jackie-chat",
      {
        messages,
        ...(model ? { model } : {}),
        ...(context ? { context } : {}),
      },
      { signal },
    );

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => null);
      // The function now sends `detail` alongside `error` for the failures a
      // person can act on — a missing key, a refused key, the gateway's own
      // words. Showing only `error` threw that away.
      const detail = typeof errorData?.detail === "string" ? errorData.detail : "";
      const base =
        resp.status === 429
          ? "Rate limit hit. Wait a moment and try again."
          : resp.status === 402
          ? "Usage limit reached. Add credits to continue."
          : typeof errorData?.error === "string"
          ? errorData.error
          : `Jackie's server answered HTTP ${resp.status}.`;
      finishWith(() => onError(detail && detail !== base ? `${base} ${detail}` : base));
      return;
    }

    if (!resp.body) {
      finishWith(() => onError("No response stream."));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let received = 0;
    let streamError: string | null = null;

    const abort = () => reader.cancel().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });

    const takeFrame = (line: string): "stop" | "continue" => {
      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") return "stop";
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        return "continue";
      }
      const { content, error } = readFrame(parsed);
      if (error) {
        streamError = error;
        return "stop";
      }
      if (content) {
        received += content.length;
        onDelta(content);
      }
      return "continue";
    };

    try {
      while (!done) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIdx);
          const rest = buffer.slice(newlineIdx + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") {
            buffer = rest;
            continue;
          }
          if (!line.startsWith("data: ")) {
            buffer = rest;
            continue;
          }

          buffer = rest;
          if (takeFrame(line) === "stop") {
            done = true;
            break;
          }
        }
      }

      // A frame can be left in the buffer without its trailing newline.
      if (!done && buffer.trim()) {
        for (let raw of buffer.split("\n")) {
          if (raw.endsWith("\r")) raw = raw.slice(0, -1);
          if (!raw.startsWith("data: ")) continue;
          if (takeFrame(raw) === "stop") break;
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }

    if (signal?.aborted) return; // The user stopped it. Not a success, not a failure.

    if (streamError) {
      finishWith(() => onError(streamError!));
      return;
    }

    // Reaching the end with nothing to show is a failure, however cleanly the
    // stream closed. Reporting it as success is what produced blank replies.
    if (received === 0) {
      finishWith(() =>
        onError("Jackie's model returned an empty answer. Try again, or switch model."),
      );
      return;
    }

    finishWith(onDone);
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === "AbortError") return;
    // "Failed to fetch" is what the user used to be shown here, which names
    // neither the cause nor anything they could do about it.
    finishWith(() => onError(describeEdgeFailure(e, "jackie-chat")));
  }
}
