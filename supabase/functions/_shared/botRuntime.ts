import { z } from "npm:zod@4.6.7";

export const BOT_PLATFORMS = ["telegram", "discord", "web", "api"] as const;
export const BotRequest = z.object({
  platform: z.enum(BOT_PLATFORMS),
  message: z.string().trim().min(1).max(16_000),
}).strict();

export interface BotPorts {
  prompt: () => Promise<{ prompt: string; headers: Record<string, string>; recorded: Promise<void> }>;
  complete: (messages: { role: "system" | "user"; content: string }[]) => Promise<string>;
}

/** Platform adapters only deliver text; they never select a different identity. */
export async function answerBot(input: z.infer<typeof BotRequest>, ports: BotPorts) {
  const guarded = await ports.prompt();
  try {
    const reply = await ports.complete([
      { role: "system", content: guarded.prompt },
      { role: "user", content: input.message },
    ]);
    if (!reply.trim()) throw new Error("The model returned no answer. Try again.");
    return { reply, platform: input.platform, headers: guarded.headers };
  } finally {
    await guarded.recorded;
  }
}