export interface TrafficState {
  x: number;
  y: number;
  tick: number;
  target: string;
  stuck: number;
  failures: number;
  retryAt?: number;
}

export interface MoveRequest { name: string; from: string; to: string; priority: number }

/** Resolve destination contention before following occupancy dependencies.
 * Closed cycles are legal simultaneous rotations; a stationary occupant blocks a chain.
 */
export function arbitrateMoves(requests: MoveRequest[], occupants: Record<string, string>): Set<string> {
  const destinations = new Set<string>();
  const selected = new Map<string, MoveRequest>();
  for (const request of [...requests].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))) {
    if (request.from === request.to || destinations.has(request.to) || selected.has(request.name)) continue;
    destinations.add(request.to);
    selected.set(request.name, request);
  }
  const accepted = new Set<string>();
  for (const request of selected.values()) {
    const chain = new Set<string>();
    let current: MoveRequest | undefined = request;
    let movable = false;
    while (current) {
      if (chain.has(current.name) || accepted.has(current.name)) { movable = true; break; }
      chain.add(current.name);
      const occupant = occupants[current.to];
      if (!occupant) { movable = true; break; }
      current = selected.get(occupant);
    }
    if (movable) for (const name of chain) accepted.add(name);
  }
  return accepted;
}

/** Count only consecutive, unfatigued movement attempts towards the same goal. */
export function observeTraffic(previous: TrafficState | undefined, x: number, y: number, tick: number, target: string, fatigued: boolean): TrafficState {
  const same = previous?.x === x && previous.y === y && previous.target === target;
  const stuck = same && previous.tick === tick - 1 && !fatigued ? previous.stuck + 1 : 0;
  const failures = same ? previous.failures : 0;
  if (stuck >= 20) {
    return { x, y, tick, target, stuck: 0, failures: Math.min(6, failures + 1), retryAt: tick + Math.min(100, 10 * 2 ** failures) };
  }
  return { x, y, tick, target, stuck, failures };
}
