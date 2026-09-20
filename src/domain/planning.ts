export interface Tile { x: number; y: number }

/**
 * Ring scan around the spawn for extension tiles: increasing Chebyshev range
 * starting at 2 (range 1 must stay open so a structure ring cannot seal the
 * spawn's exits), skipping occupied or out-of-bounds tiles. Deterministic —
 * compaction order inside a ring — so resets and replays rebuild the identical
 * layout instead of drifting with find() ordering.
 */
export function extensionTiles(origin: Tile, free: (x: number, y: number) => boolean, count: number): Tile[] {
  const tiles: Tile[] = [];
  for (let range = 2; range <= 5 && tiles.length < count; range++) {
    const ring: Tile[] = [];
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
        if (!free(x, y)) continue;
        ring.push({ x, y });
      }
    }
    ring.sort((a, b) =>
      Math.abs(a.x - origin.x) + Math.abs(a.y - origin.y) - (Math.abs(b.x - origin.x) + Math.abs(b.y - origin.y))
      || a.x - b.x || a.y - b.y);
    tiles.push(...ring);
  }
  return tiles.slice(0, count);
}

/**
 * False when blocking `tile` would strand part of the room: an extension site is
 * an obstacle from the moment it is placed (engine treats solid sites as blocking),
 * so a tile whose passable neighbours cannot all reach each other without crossing
 * it is a local cut vertex — a corridor or pocket entrance. The search runs in a
 * bounded box around the tile; a detour longer than that radius counts as
 * disconnected, which errs toward skipping a placement rather than sealing a route.
 */
export function preservesConnectivity(tile: Tile, passable: (x: number, y: number) => boolean): boolean {
  const key = (x: number, y: number) => `${x}:${y}`;
  const neighbors: Tile[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    const x = tile.x + dx, y = tile.y + dy;
    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
    if (passable(x, y)) neighbors.push({ x, y });
  }
  const start = neighbors[0];
  if (!start || neighbors.length <= 1) return true;
  const reached = new Set<string>([key(start.x, start.y)]);
  const queue = [start];
  while (queue.length) {
    const current = queue.pop()!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const x = current.x + dx, y = current.y + dy;
      if (x === tile.x && y === tile.y) continue;
      if (Math.abs(x - tile.x) > 12 || Math.abs(y - tile.y) > 12) continue;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      const id = key(x, y);
      if (reached.has(id) || !passable(x, y)) continue;
      reached.add(id);
      queue.push({ x, y });
    }
  }
  return neighbors.every(n => reached.has(key(n.x, n.y)));
}

/**
 * 殖民地 spawn 落点(纯,M5-3):控制器 2..6 环带内的可建格中,最小化到
 * 控制器与各源的切比雪夫最远距离(minimax——spawn 是全房物流枢纽,兼顾
 * 升级与采矿两个方向);同分按坐标字典序保证确定性。割点守卫与 extension
 * 同款:落子不得把房间割断(v1 工地封路教训)。无合法格返回 undefined。
 */
export function spawnTile(controller: Tile, sources: readonly Tile[], free: (x: number, y: number) => boolean, passable: (x: number, y: number) => boolean): Tile | undefined {
  let best: Tile | undefined;
  let bestScore = Infinity;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      if (ring < 2 || ring > 6) continue;
      const x = controller.x + dx;
      const y = controller.y + dy;
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      if (!free(x, y)) continue;
      if (!preservesConnectivity({ x, y }, passable)) continue;
      const score = Math.max(ring, ...sources.map(s => Math.max(Math.abs(x - s.x), Math.abs(y - s.y))));
      if (score < bestScore || (score === bestScore && best !== undefined && (x < best.x || (x === best.x && y < best.y)))) {
        best = { x, y };
        bestScore = score;
      }
    }
  }
  return best;
}
