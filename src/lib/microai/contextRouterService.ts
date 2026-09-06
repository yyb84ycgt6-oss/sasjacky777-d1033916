/**
 * Running a routed question end to end, offline.
 *
 * The router table says which small model is expert in which partitions;
 * `selectEngine` says which engine may answer. This is the part that actually
 * does it: gather context from the partitions that router reads, pick the
 * nearest engine that is ready, answer, and write the exchange back into the
 * conversations partition so the next question can recall it — with no network
 * involved at any step.
 *
 * Engines are injected. Availability is asked once per ask and handed to the
 * selector as data, so the decision stays the pure function that is tested, and
 * an engine that lies about being ready shows up as a failed run rather than as
 * a silently different route.
 */
import type { PartitionService } from "@/lib/partitions/service";
import type { PartitionId } from "@/lib/partitions/types";
import { OLLAMA_HOST, runLocalModel } from "@/lib/localAI";
import {
  routeIntent,
  routerModel,
  selectEngine,
  type ContextRouterSpec,
  type InferenceEngine,
} from "./contextRouter";

/** Most recent records pulled from each partition a router reads. */
export const CONTEXT_DEPTH = 6;

export interface RoutedAnswer {
  router: ContextRouterSpec;
  /** Null when nothing was ready to answer — offline with no local engine. */
  engine: InferenceEngine | null;
  /** Why this engine, or why none. */
  reason: string;
  text: string;
  /** Records that went into the prompt, newest first. */
  context: Array<{ partition: PartitionId; key: string }>;
}

export function ollamaEngine(
  // Wrapped rather than passed bare: a detached `fetch` reference throws
  // "Illegal invocation" in a browser, which would read here as Ollama being
  // down on every check.
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input),
): InferenceEngine {
  return {
    id: "ollama",
    name: "Ollama",
    locality: "lan",
    available: async () => {
      try {
        const res = await fetchImpl(`${OLLAMA_HOST}/api/tags`);
        return res.ok;
      } catch {
        return false;
      }
    },
    run: async (prompt, model) => {
      const result = await runLocalModel(prompt, model ? { model } : {});
      return { text: result.text, model: result.model };
    },
  };
}

export class ContextRouterService {
  constructor(
    private readonly partitions: PartitionService,
    private readonly engines: InferenceEngine[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Newest records from the partitions this router is expert in. */
  private async gather(router: ContextRouterSpec) {
    const found: Array<{ partition: PartitionId; key: string; body: string; updatedAt: number }> = [];

    for (const partition of router.reads) {
      const records = await this.partitions.list(partition);
      for (const record of records) {
        found.push({
          partition,
          key: record.key,
          body: record.body,
          updatedAt: record.updatedAt,
        });
      }
    }

    return found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CONTEXT_DEPTH);
  }

  /** Which engines say they can answer right now. */
  private async ready(): Promise<Set<string>> {
    const results = await Promise.all(
      this.engines.map(async (engine) => {
        try {
          return (await engine.available()) ? engine.id : null;
        } catch {
          return null;
        }
      }),
    );
    return new Set(results.filter((id): id is string => id !== null));
  }

  async ask(intent: string, online: boolean): Promise<RoutedAnswer> {
    const router = routeIntent(intent);
    const context = await this.gather(router);
    const { engine, reason } = selectEngine(router, this.engines, await this.ready(), online);

    if (!engine) {
      return {
        router,
        engine: null,
        reason,
        text: "",
        context: context.map(({ partition, key }) => ({ partition, key })),
      };
    }

    const prompt = [
      `You are ${router.name}. ${router.specialty}`,
      context.length
        ? `Context from ${router.reads.join(", ")}:\n${context.map((c) => `- [${c.partition}/${c.key}] ${c.body}`).join("\n")}`
        : "No stored context yet.",
      `Question: ${intent}`,
    ].join("\n\n");

    const { text } = await engine.run(prompt, routerModel(router.id).id);

    // The exchange is context for the next question, so it is written where
    // Recall will find it — locally, with a checksum, backed up on next sync.
    await this.partitions.put(
      "conversations",
      `${router.id}-${this.now()}`,
      JSON.stringify({ intent, text, router: router.id, engine: engine.id }),
    );

    return {
      router,
      engine,
      reason,
      text,
      context: context.map(({ partition, key }) => ({ partition, key })),
    };
  }
}
