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
 * Engines are injected. Availability comes from the shared observer rather than
 * from a fresh probe per request, and the route comes from a plan that is
 * reused while its invariants hold. So the common case — ask, ask again — costs
 * a few set lookups instead of a full re-derivation, and the decision itself
 * stays the pure function that is tested.
 */
import type { PartitionService } from "@/lib/partitions/service";
import type { PartitionId } from "@/lib/partitions/types";
import { OLLAMA_HOST, runLocalModel } from "@/lib/localAI";
import { advancePlan, type PathPlan } from "@/lib/squad/pathPlanner";
import { WorldObserver } from "@/lib/squad/observer";
import {
  routeIntent,
  routerModel,
  type ContextRouterSpec,
  type InferenceEngine,
} from "./contextRouter";

/** Most recent records pulled from each partition a router reads. */
export const CONTEXT_DEPTH = 6;

export interface RouterStats {
  asks: number;
  /** Asks that reused the standing plan. */
  held: number;
  /** Asks that re-derived it, and why the last one did. */
  replanned: number;
  lastReplanReason: string;
}

export interface RoutedAnswer {
  router: ContextRouterSpec;
  /** Null when nothing was ready to answer — offline with no local engine. */
  engine: InferenceEngine | null;
  /** Why this engine, or why none. */
  reason: string;
  text: string;
  /** Records that went into the prompt, newest first. */
  context: Array<{ partition: PartitionId; key: string }>;
  /** True when this ask re-derived the route rather than holding the plan. */
  replanned: boolean;
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
  private plans = new Map<string, PathPlan>();
  private stats: RouterStats = { asks: 0, held: 0, replanned: 0, lastReplanReason: "no plan yet" };
  private readonly observer: WorldObserver;

  constructor(
    private readonly partitions: PartitionService,
    private readonly engines: InferenceEngine[],
    private readonly now: () => number = () => Date.now(),
    observer?: WorldObserver,
  ) {
    this.observer = observer ?? new WorldObserver(engines, now);
  }

  getStats(): RouterStats & { looks: number; reuses: number } {
    return { ...this.stats, ...this.observer.getStats() };
  }

  /** The standing plan for a router, if it has one. */
  getPlan(routerId: ContextRouterSpec["id"]): PathPlan | null {
    return this.plans.get(routerId) ?? null;
  }

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

  async ask(intent: string, online: boolean): Promise<RoutedAnswer> {
    const router = routeIntent(intent);
    const context = await this.gather(router);

    // One look, shared with every other caller; then the plan, reused while it
    // holds. Neither the probe nor the ladder walk repeats on an unchanged
    // world, which is the ordinary case.
    const observation = await this.observer.observe(online);
    const advanced = advancePlan(this.plans.get(router.id) ?? null, router, this.engines, observation);
    this.plans.set(router.id, advanced.plan);

    this.stats.asks += 1;
    if (advanced.replanned) {
      this.stats.replanned += 1;
      this.stats.lastReplanReason = advanced.reason;
    } else {
      this.stats.held += 1;
    }

    const engine = advanced.plan.engineId
      ? (this.engines.find((e) => e.id === advanced.plan.engineId) ?? null)
      : null;
    const reason = advanced.plan.reason;

    if (!engine) {
      return {
        router,
        engine: null,
        reason,
        text: "",
        context: context.map(({ partition, key }) => ({ partition, key })),
        replanned: advanced.replanned,
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
      replanned: advanced.replanned,
    };
  }
}
