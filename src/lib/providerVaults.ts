/**
 * Five vaults of provider keys, each with its own fallback order.
 *
 * The Provider Hub lists sixteen providers and one fallback order for all of
 * them. That order is right for nobody in particular: someone who wants
 * answers fast wants Groq and Cerebras first, someone writing code wants
 * Codestral and DeepSeek first, someone on their own rig wants Ollama first.
 * A vault is one of those intents written down: five providers in the order
 * that suits it, each with the key it needs and the exact page that key is
 * made on.
 *
 * The key page is the point. Getting a provider key means finding the right
 * console, the right settings tab, the right button, on a site that
 * reorganises itself every few months. Each slot here links straight to the
 * page where the key is created, and names the secret it has to be pasted
 * into, so a key takes a click and a paste rather than a search.
 *
 * 5 vaults × 5 slots = 25 key slots. A provider can sit in more than one vault
 * (Groq is fast *and* free), so that is 25 slots over the 15 keyed providers,
 * not 25 different keys.
 *
 * ## Fallback
 *
 * A vault's five come first, then every other provider in the hub's own order.
 * So a vault never has fewer than five backups behind its first choice, and a
 * vault whose five keys are all missing still ends in an answer from whatever
 * is configured — the Lovable gateway needs no key at all.
 */
import { FALLBACK_ORDER, findProvider, type ProviderId } from "./jackie-providers";

export type VaultId = "free" | "home" | "speed" | "brains" | "code";

/** One key slot: a provider, and the model this vault wants from it. */
export interface VaultSlot {
  provider: ProviderId;
  /**
   * Must be one of the provider's own models — the function's allowlist
   * refuses anything else, and on a fallback chain a refused model looks
   * exactly like a dead provider (CLAUDE.md rule 5). Omitted = provider default.
   */
  model?: string;
}

export interface VaultDef {
  id: VaultId;
  name: string;
  /** What this vault is for, in one line. */
  purpose: string;
  slots: readonly VaultSlot[];
}

export const SLOTS_PER_VAULT = 5;

/** Backups every vault has behind its first choice, at minimum. */
export const MIN_FALLBACKS = 5;

export const VAULTS: readonly VaultDef[] = [
  {
    id: "free",
    name: "Free Vault",
    purpose: "Five providers with free API keys. $0 to fill.",
    slots: [
      { provider: "groq" },
      { provider: "google" },
      { provider: "openrouter" },
      { provider: "mistral" },
      { provider: "cerebras" },
    ],
  },
  {
    id: "home",
    name: "Home Vault",
    purpose: "Your own hardware first, then the cheapest clouds.",
    slots: [
      { provider: "ollama" },
      { provider: "bionic" },
      { provider: "openrouter" },
      { provider: "groq" },
      { provider: "hf" },
    ],
  },
  {
    id: "speed",
    name: "Speed Vault",
    purpose: "The fastest inference there is, for when waiting is the problem.",
    slots: [
      { provider: "cerebras" },
      { provider: "groq", model: "llama-3.1-8b-instant" },
      { provider: "fireworks" },
      { provider: "together" },
      { provider: "deepinfra" },
    ],
  },
  {
    id: "brains",
    name: "Brains Vault",
    purpose: "The strongest reasoning models, for the hard questions.",
    slots: [
      { provider: "anthropic" },
      { provider: "openai" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "xai" },
      { provider: "google", model: "gemini-1.5-pro" },
    ],
  },
  {
    id: "code",
    name: "Code Vault",
    purpose: "Models that are best at writing and fixing code.",
    slots: [
      { provider: "deepseek" },
      { provider: "mistral", model: "codestral-latest" },
      { provider: "together", model: "Qwen/Qwen2.5-Coder-32B-Instruct" },
      { provider: "deepinfra", model: "Qwen/Qwen2.5-Coder-32B-Instruct" },
      { provider: "fireworks", model: "accounts/fireworks/models/qwen2p5-coder-32b-instruct" },
    ],
  },
];

export function findVault(id: unknown): VaultDef | undefined {
  return VAULTS.find((v) => v.id === id);
}

/** What the "Get key" button needs: the secret, and where it is made. */
export interface KeySlot {
  provider: ProviderId;
  label: string;
  secret: string;
  /** The page the key (or, for a local runner, its setup) is made on. */
  url: string;
  /** Local runners take a base URL, not a key — the button should say so. */
  kind: "key" | "url";
  model: string;
}

export function keySlots(vault: VaultDef): KeySlot[] {
  return vault.slots.flatMap((slot) => {
    const def = findProvider(slot.provider);
    // A slot pointing at a provider with no secret or no key page would render
    // a button that goes nowhere; the tests refuse such a vault, and this
    // keeps a bad edit from crashing the page while the tests catch it.
    if (!def?.requiresSecret || !def.helpUrl) return [];
    return [{
      provider: def.id,
      label: def.label,
      secret: def.requiresSecret,
      url: def.helpUrl,
      kind: def.requiresSecret.endsWith("_BASE_URL") ? "url" : "key",
      model: slot.model ?? def.models[0]?.id ?? "",
    }];
  });
}

/**
 * The full order a vault tries: its own five with their chosen models, then
 * every other provider on its default model.
 */
export function vaultChain(vault: VaultDef): { provider: ProviderId; model?: string }[] {
  const own = vault.slots.map((s) => ({ provider: s.provider, model: s.model }));
  const taken = new Set(own.map((s) => s.provider));
  const rest = FALLBACK_ORDER.filter((p) => !taken.has(p)).map((provider) => ({ provider }));
  return [...own, ...rest];
}
