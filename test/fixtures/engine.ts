/**
 * Minimal engine stubs for unit tests.
 *
 * The engine provides `Game`, `Memory`, etc. as globals. Tests install these
 * onto `globalThis` so pure-logic and kernel code can run under vitest with no
 * engine present.
 *
 * Scope: this stub covers only what the kernel touches today. It is
 * deliberately not a full engine emulation — for anything beyond CPU/Memory
 * bookkeeping, add the specific surface being tested.
 */

export interface FakeCpu {
  limit: number;
  tickLimit: number;
  used: number;
  getUsed(): number;
}

export interface FakeGame {
  time: number;
  cpu: FakeCpu;
}

export interface FakeEngine {
  game: FakeGame;
  /** Captured `console.log` lines, in order. */
  logs: string[];
  /** Move the tick forward one step. */
  advanceTick(): void;
  /** Spend CPU, as engine work would. */
  spend(cpu: number): void;
  /** Restore the previous globals. Call in `afterEach`. */
  restore(): void;
}

export interface FakeEngineOptions {
  /** Account CPU baseline. Defaults to the un-unlocked official limit. */
  cpuLimit?: number;
  /** Per-tick ceiling including bucket borrow. Defaults to the baseline. */
  cpuTickLimit?: number;
}

interface EngineGlobals {
  Game?: unknown;
  Memory?: unknown;
  console?: unknown;
}

/**
 * Install fake engine globals and capture console output.
 *
 * `Game.cpu.poll` semantics are modelled honestly: `getUsed()` reflects CPU
 * spent so far this tick, and the counter resets on `advanceTick()`.
 */
export function installFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const globals = globalThis as EngineGlobals;
  const previous: EngineGlobals = {
    Game: globals.Game,
    Memory: globals.Memory,
    console: globals.console,
  };

  const cpu: FakeCpu = {
    limit: options.cpuLimit ?? 20,
    tickLimit: options.cpuTickLimit ?? options.cpuLimit ?? 20,
    used: 0,
    getUsed(): number {
      return this.used;
    },
  };

  const game: FakeGame = { time: 1, cpu };
  const logs: string[] = [];

  globals.Game = game;
  globals.Memory = {};
  globals.console = {
    ...console,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    },
  };

  return {
    game,
    logs,
    advanceTick(): void {
      game.time += 1;
      cpu.used = 0;
    },
    spend(cpuSpent: number): void {
      cpu.used += cpuSpent;
    },
    restore(): void {
      globals.Game = previous.Game;
      globals.Memory = previous.Memory;
      globals.console = previous.console;
    },
  };
}
