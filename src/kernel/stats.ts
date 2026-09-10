/**
 * Stats export via a RawMemory segment.
 *
 * Why a segment and not `Memory`: the rate limits differ by 6x.
 *   GET /api/user/memory-segment -> 360/hour
 *   GET /api/user/memory         -> 1440/day  (1/minute)
 * Same information, six times the observation bandwidth, for free.
 *
 * Segment contents are NOT part of the 2 MB Memory budget and are not parsed by
 * the engine every tick, so this is also the cheap place to put numbers.
 *
 * Ship discipline: segments are written on an interval, not every tick.
 * `RawMemory.set` plus `JSON.stringify` on every tick would be real CPU spent
 * producing data nobody reads that fast.
 */
import { heapGet, heapSet } from './heap';
import { memoryBytes } from './memory';
import { profileSnapshot } from './profiler';
import { errorCounts } from './errors';

/**
 * Segment id for stats. Must match `DEFAULT_SEGMENT` in scripts/stats.mjs.
 * Segment 0 is conventionally reserved, so start above it.
 */
export const STATS_SEGMENT = 90;

/** Ticks between segment writes. */
const WRITE_INTERVAL = 50;

/** Ticks of history retained in the segment. */
const HISTORY = 20;

interface Sample {
  gameTime: number;
  cpu: { used: number; limit: number; bucket: number };
  creeps: number;
  rcl: number;
  rooms: number;
  memoryBytes: number;
  /** Rolling mean CPU per phase since the last sample. */
  phases: Record<string, number>;
  /** Cumulative failure count per error signature. */
  errors: Record<string, number>;
}

/**
 * Record a stats sample and flush the segment on the configured interval.
 *
 * Kept cheap on the non-write path: the sample itself is assembled from cheap
 * counters, and `memoryBytes` (the only expensive part, a full stringify) is
 * only computed on ticks where the segment is actually written.
 */
export function maybeWriteStats(): void {
  // The write marker lives in the heap so it shares the lifecycle of all other
  // kernel scratch state; losing it just means one extra sample.
  const lastWrite = heapGet<number>('statsLastWrite', () => -Infinity);
  if (Game.time - lastWrite < WRITE_INTERVAL) return;
  heapSet('statsLastWrite', Game.time);

  const sample: Sample = {
    gameTime: Game.time,
    cpu: {
      used: Number(Game.cpu.getUsed().toFixed(2)),
      limit: Game.cpu.limit,
      bucket: Game.cpu.bucket,
    },
    creeps: Object.keys(Game.creeps).length,
    ...summarizeRooms(),
    memoryBytes: memoryBytes(),
    phases: profileSnapshot(),
    errors: errorCounts(),
  };

  const history = readHistory();
  history.push(sample);
  while (history.length > HISTORY) history.shift();

  RawMemory.setActiveSegments([STATS_SEGMENT]);
  RawMemory.segments[STATS_SEGMENT] = JSON.stringify(history);
}

/**
 * Room count and highest controller level owned.
 *
 * Iterates our own rooms only — scanning all visible rooms would make this
 * cost scale with vision rather than with what we own.
 */
function summarizeRooms(): { rooms: number; rcl: number } {
  let rooms = 0;
  let rcl = 0;

  for (const name of Object.keys(Game.rooms)) {
    const controller = Game.rooms[name]?.controller;
    if (controller?.my !== true) continue;

    rooms += 1;
    if (controller.level > rcl) rcl = controller.level;
  }
  return { rooms, rcl };
}

/** Parse the history already in the segment, tolerating garbage. */
function readHistory(): Sample[] {
  const raw = RawMemory.segments[STATS_SEGMENT];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Sample[]) : [];
  } catch {
    // A truncated or hand-edited segment must not break the tick.
    return [];
  }
}
