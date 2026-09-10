/**
 * Minimal engine stubs for unit tests.
 *
 * The engine provides `Game`, `Memory`, `RawMemory`, etc. as globals. Tests
 * install these onto `globalThis` so kernel code can run under vitest with no
 * engine present.
 *
 * Scope: this stub covers only what the kernel touches today. It is
 * deliberately not a full engine emulation — for anything beyond CPU / Memory /
 * RawMemory bookkeeping, add the specific surface being tested.
 */

export interface FakeCpu {
  limit: number;
  tickLimit: number;
  bucket: number;
  used: number;
  getUsed(): number;
}

export interface FakeGame {
  time: number;
  cpu: FakeCpu;
  creeps: Record<string, unknown>;
  rooms: Record<string, unknown>;
  getObjectById(id: string): unknown;
}

export interface FakeRawMemory {
  segments: Record<number, string>;
  setActiveSegments(ids: number[]): number[];
}

export interface FakeEngine {
  game: FakeGame;
  memory: Record<string, unknown>;
  rawMemory: FakeRawMemory;
  /** Captured `console.log` lines, in order. */
  logs: string[];
  /** Move the tick forward one step. */
  advanceTick(): void;
  /** Spend CPU, as engine work would. */
  spend(cpu: number): void;
  /** Register an object so `Game.getObjectById` resolves it. */
  addObject(id: string, object: unknown): void;
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
  RawMemory?: unknown;
  console?: unknown;
}

/**
 * Install fake engine globals and capture console output.
 *
 * `Game.cpu` semantics are modelled honestly: `getUsed()` reflects CPU spent so
 * far this tick, and the counter resets on `advanceTick()`.
 *
 * The `global` object is also cleared between installs, because the kernel keeps
 * cross-tick state there and a leaked heap between tests would make results
 * order-dependent.
 */
export function installFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const globals = globalThis as EngineGlobals & Record<string, unknown>;
  const previous = {
    Game: globals.Game,
    Memory: globals.Memory,
    RawMemory: globals.RawMemory,
    console: globals.console,
    heap: globals.__screep_heap,
  };

  const cpu: FakeCpu = {
    limit: options.cpuLimit ?? 20,
    tickLimit: options.cpuTickLimit ?? options.cpuLimit ?? 20,
    bucket: 0,
    used: 0,
    getUsed(): number {
      return this.used;
    },
  };

  const objects = new Map<string, unknown>();

  const game: FakeGame = {
    time: 1,
    cpu,
    creeps: {},
    rooms: {},
    getObjectById(id: string): unknown {
      return objects.get(id) ?? null;
    },
  };

  const rawMemory: FakeRawMemory = {
    segments: {},
    setActiveSegments(ids: number[]): number[] {
      return ids;
    },
  };

  const logs: string[] = [];
  const memory: Record<string, unknown> = {};

  globals.Game = game;
  globals.Memory = memory;
  globals.RawMemory = rawMemory;
  delete globals.__screep_heap;
  globals.console = {
    ...console,
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    },
  };

  return {
    game,
    memory,
    rawMemory,
    logs,
    advanceTick(): void {
      game.time += 1;
      cpu.used = 0;
    },
    spend(cpuSpent: number): void {
      cpu.used += cpuSpent;
    },
    addObject(id: string, object: unknown): void {
      objects.set(id, object);
    },
    restore(): void {
      globals.Game = previous.Game;
      globals.Memory = previous.Memory;
      globals.RawMemory = previous.RawMemory;
      globals.console = previous.console;
      if (previous.heap === undefined) delete globals.__screep_heap;
      else globals.__screep_heap = previous.heap;
    },
  };
}
