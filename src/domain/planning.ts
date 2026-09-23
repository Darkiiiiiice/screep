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
 * 放置守卫：在 tile 落一个障碍结构后，其 8 邻域里任何不可通行格（结构/墙/源/矿）
 * 必须仍保留至少一个可及格（不含 tile 本身）。否则该邻居永远无法被 creep 贴身，
 * range-1 交互（transfer/repair/harvest）几何不可能——成为封印格（线上实证：
 * 扩展环闭合把 (23,20) 扩展 8 邻域全封死，派单板反复把它的空位派给工人形成冻结）。
 * 与 preservesConnectivity 同 Doctrine：拿不准就跳过这次放置。
 */
export function preservesApproaches(tile: Tile, passable: (x: number, y: number) => boolean): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    const nx = tile.x + dx, ny = tile.y + dy;
    if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
    if (passable(nx, ny)) continue;
    let open = false;
    for (let ax = -1; ax <= 1 && !open; ax++) for (let ay = -1; ay <= 1 && !open; ay++) {
      if (!ax && !ay) continue;
      const cx = nx + ax, cy = ny + ay;
      if (cx === tile.x && cy === tile.y) continue;
      if (cx < 0 || cx > 49 || cy < 0 || cy > 49) continue;
      if (passable(cx, cy)) open = true;
    }
    if (!open) return false;
  }
  return true;
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

/**
 * link 选点(M6-3):源链优先(每源一链,贴容器以接矿工外溢),全源有链后
 * 补中枢链(贴 storage,搬运链就近取能)。确定性排序:贴容器 > 距锚点 >
 * 坐标序;不贴既有 link(避免互相堵位),cap 硬顶。容量序:源1 → 中枢 →
 * 源2…(RCL5 cap 2 时保证 源+中枢 可用,调拨图成立)。
 */
export function linkSite(args: {
  sources: readonly Tile[];
  containers: readonly Tile[];
  storage?: Tile | undefined;
  links: readonly Tile[];
  capacity: number;
  free: (x: number, y: number) => boolean;
  /** 提供则跳过会封印邻居可及格的候选（防 sealed sink）。 */
  passable?: (x: number, y: number) => boolean;
}): Tile | undefined {
  const chebyshev = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  if (args.links.length >= args.capacity) return undefined;
  const box = (anchor: Tile, wantContainer: boolean): Tile | undefined => {
    const nearby = args.containers.filter(c => chebyshev(c, anchor) <= 2);
    const candidates: Tile[] = [];
    for (let x = anchor.x - 2; x <= anchor.x + 2; x++) {
      for (let y = anchor.y - 2; y <= anchor.y + 2; y++) {
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (!args.free(x, y)) continue;
        const tile = { x, y };
        // 源地块不在 LOOK_STRUCTURES 里,free() 看不见——显式排除,
        // 否则 link 会盖住矿头(mockup 放行、真引擎拒,且堵死采矿)。
        if (args.sources.some(s => s.x === x && s.y === y)) continue;
        if (args.passable && !preservesApproaches(tile, args.passable)) continue;
        if (args.links.some(l => chebyshev(l, tile) <= 1)) continue;
        candidates.push(tile);
      }
    }
    if (!candidates.length) return undefined;
    const score = (t: Tile) => {
      const containerAdj = wantContainer && nearby.some(c => chebyshev(c, t) <= 1) ? 0 : 1;
      return containerAdj * 10 + chebyshev(t, anchor);
    };
    candidates.sort((a, b) => score(a) - score(b) || a.x - b.x || a.y - b.y);
    return candidates[0];
  };
  const ordered = [...args.sources].sort((a, b) => a.x - b.x || a.y - b.y);
  const sourceLinks = args.links.filter(l => args.sources.some(s => chebyshev(l, s) <= 2));
  const unlinked = ordered.filter(source => !args.links.some(l => chebyshev(l, source) <= 2));
  // 容量序:源1 → 中枢 → 源2…。中枢必须先于第二源链:RCL5 cap 2 的双源房
  // 若两源先占满,中枢永不存在,调拨图不成立。中枢=不邻源的那条链。
  if (sourceLinks.length === 0) {
    const first = unlinked[0];
    if (first) {
      const site = box(first, true);
      if (site) return site;
    }
  }
  if (args.storage && sourceLinks.length === args.links.length) {
    const site = box(args.storage, false);
    if (site) return site;
  }
  for (const source of unlinked) {
    const site = box(source, true);
    if (site) return site;
  }
  return undefined;
}

/**
 * terminal 选点(M6-4):贴 storage(2 环)保取送动线;确定性排序(距 storage >
 * 坐标序);避开既有 link(≤1 环,不再叠产线);源/矿地块由 free 过滤(矿不在
 * LOOK_STRUCTURES,free 必须显式排除)。cap 由 growth 链把关,这里只管选址。
 */
export function terminalSite(args: {
  storage?: Tile | undefined;
  links: readonly Tile[];
  free: (x: number, y: number) => boolean;
  /** 提供则跳过会封印邻居可及格的候选（防 sealed sink）。 */
  passable?: (x: number, y: number) => boolean;
}): Tile | undefined {
  if (!args.storage) return undefined;
  const chebyshev = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const candidates: Tile[] = [];
  for (let x = args.storage.x - 2; x <= args.storage.x + 2; x++) {
    for (let y = args.storage.y - 2; y <= args.storage.y + 2; y++) {
      if (!args.free(x, y)) continue;
      const tile = { x, y };
      if (chebyshev(tile, args.storage) === 0) continue;
      if (args.links.some(l => chebyshev(l, tile) <= 1)) continue;
      if (args.passable && !preservesApproaches(tile, args.passable)) continue;
      candidates.push(tile);
    }
  }
  const anchor = args.storage;
  candidates.sort((a, b) => chebyshev(a, anchor) - chebyshev(b, anchor) || a.x - b.x || a.y - b.y);
  return candidates[0];
}

/**
 * extractor 选点(M6-4):唯一合法位置是矿体地块本身(engine 的
 * extractor 在 obstacle 表豁免,只能建在 mineral 上);已有 extractor
 * (在建或建成)覆盖的矿体不再重复。多矿按坐标序取第一个。
 */
export function extractorSite(args: {
  minerals: readonly Tile[];
  extractors: readonly Tile[];
}): Tile | undefined {
  const covered = (t: Tile) => args.extractors.some(e => e.x === t.x && e.y === t.y);
  return args.minerals.filter(m => !covered(m)).sort((a, b) => a.x - b.x || a.y - b.y)[0];
}

/**
 * factory 选点(M6-7):以 terminal 为锚(4 环内——lab 簇占 3 环,压条站
 * 退一环避让),与既有 factory 不叠建;确定性排序:距锚 > 坐标序。
 * cap 由 growth 链把关,这里只管选址。
 */
export function factorySite(args: {
  anchor?: Tile | undefined;
  factories: readonly Tile[];
  free: (x: number, y: number) => boolean;
  /** 提供则跳过会封印邻居可及格的候选（防 sealed sink）。 */
  passable?: (x: number, y: number) => boolean;
}): Tile | undefined {
  if (!args.anchor) return undefined;
  const chebyshev = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const candidates: Tile[] = [];
  for (let x = args.anchor.x - 4; x <= args.anchor.x + 4; x++) {
    for (let y = args.anchor.y - 4; y <= args.anchor.y + 4; y++) {
      const tile = { x, y };
      if (!args.free(x, y)) continue;
      // 锚点格被 terminal 占用;即便 free 通过(纯函数不假设)也不许叠建。
      if (chebyshev(tile, args.anchor) === 0) continue;
      if (args.factories.some(f => chebyshev(f, tile) === 0)) continue;
      if (args.passable && !preservesApproaches(tile, args.passable)) continue;
      candidates.push(tile);
    }
  }
  const anchor = args.anchor;
  candidates.sort((a, b) => chebyshev(a, anchor) - chebyshev(b, anchor) || a.x - b.x || a.y - b.y);
  return candidates[0];
}

/**
 * lab 选点(M6-5):以 terminal 为锚(3 环内,取送动线),与全部既有 lab
 * 互距 ≤2(反应要求 lab1/lab2 都在输出 lab 的 2 环内——簇形是反应链的
 * 几何前提)。确定性排序:距锚 > 坐标序。cap 由 growth 链把关。
 */
export function labSite(args: {
  anchor?: Tile | undefined;
  labs: readonly Tile[];
  free: (x: number, y: number) => boolean;
  /** 提供则跳过会封印邻居可及格的候选（防 sealed sink）。 */
  passable?: (x: number, y: number) => boolean;
}): Tile | undefined {
  if (!args.anchor) return undefined;
  const chebyshev = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const candidates: Tile[] = [];
  for (let x = args.anchor.x - 3; x <= args.anchor.x + 3; x++) {
    for (let y = args.anchor.y - 3; y <= args.anchor.y + 3; y++) {
      const tile = { x, y };
      if (!args.free(x, y)) continue;
      // 锚点格被 terminal 占用;即便 free 通过(纯函数不假设)也不许叠建。
      if (chebyshev(tile, args.anchor) === 0) continue;
      if (args.labs.some(l => chebyshev(l, tile) > 2)) continue;
      if (args.passable && !preservesApproaches(tile, args.passable)) continue;
      candidates.push(tile);
    }
  }
  const anchor = args.anchor;
  candidates.sort((a, b) => chebyshev(a, anchor) - chebyshev(b, anchor) || a.x - b.x || a.y - b.y);
  return candidates[0];
}
