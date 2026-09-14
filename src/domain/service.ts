export interface ServiceState { waitingSince: number; leaseUntil?: number }
export interface ServiceCandidate { id: string; priority: number; emergency: boolean }

/** Age only live demands. A bounded lease survives dispatch, but only settled service resets age. */
export function rankServices(candidates: ServiceCandidate[], states: Record<string, ServiceState>, now: number): ServiceCandidate[] {
  const active = new Set(candidates.map(c => c.id));
  for (const id of Object.keys(states)) if (!active.has(id)) delete states[id];
  for (const candidate of candidates) states[candidate.id] ??= { waitingSince: now };
  const score = (c: ServiceCandidate) => c.priority + Math.floor(Math.max(0, now - states[c.id]!.waitingSince) / 25);
  const ranked = [...candidates].sort((a, b) => Number(b.emergency) - Number(a.emergency)
    || Number((states[b.id]!.leaseUntil ?? 0) > now) - Number((states[a.id]!.leaseUntil ?? 0) > now)
    || score(b) - score(a) || a.id.localeCompare(b.id));
  const first = ranked[0];
  if (first && (states[first.id]!.leaseUntil ?? 0) <= now) states[first.id]!.leaseUntil = now + 25;
  return ranked;
}

export function settleService(states: Record<string, ServiceState>, id: string, now: number): void {
  if (states[id]) states[id] = { waitingSince: now };
}
