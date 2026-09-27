/**
 * The city and casino modes' runtimes. The casino games themselves are each
 * player's own, played on their own screen (ui/CasinoScreens.tsx); what runs
 * here, on the host, is the house: the stake it hands each player on the way
 * in, and the goal on the board.
 */
import type { Objective } from "../game/types";
import { ModeRuntime, registerRuntime } from "./runtime";

/** Dollars a player starts High Roller with. */
export const HIGH_ROLLER_STAKE = 1000;

class HighRollerRuntime extends ModeRuntime {
  private get given(): string[] { return ((this.data.given as string[] | undefined) ??= []); }

  start(): void {
    this.title(null, "The Golden Stonk", "A thousand dollars. Make it a million.");
    this.tell(null, "Walk up to a machine or a table and use it to play: slots, blackjack, roulette, video poker on the east wall, the wheel on the north, and the Stonks terminal on the west.", "#ffcc66");
  }

  second(): void {
    // Everyone gets their stake once, whenever they walk in.
    for (const p of this.players()) {
      if (this.given.includes(p.name)) continue;
      this.given.push(p.name);
      this.giveCash(p.id, HIGH_ROLLER_STAKE);
    }
  }

  objective(): Objective {
    return { title: "The Golden Stonk", lines: [["Goal", "$1,000,000"], ["Stake", `$${HIGH_ROLLER_STAKE.toLocaleString("en-US")}`]] };
  }

  restart(): string {
    this.data.given = [];
    return "Everyone gets a fresh thousand on the house.";
  }
}

registerRuntime("high_roller", (g, d, s) => new HighRollerRuntime(g, d, s));
