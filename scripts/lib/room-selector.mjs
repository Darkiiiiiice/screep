export function candidateRooms(centers) {
  const result = new Set();
  for (const center of centers) {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(center);
    if (!m) continue;
    for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
      const x = Number(m[2]) + dx, y = Number(m[4]) + dy;
      if (x >= 0 && y >= 0) result.add(`${m[1]}${x}${m[3]}${y}`);
    }
  }
  return [...result].sort();
}

const adjacent = (index) => {
  const x = index % 50, y = Math.floor(index / 50), cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((dx || dy) && x + dx >= 0 && x + dx < 50 && y + dy >= 0 && y + dy < 50) cells.push((y + dy) * 50 + x + dx);
  }
  return cells;
};

export function evaluateRoom(room, terrain, objects, status) {
  const reject = (reason) => ({ room, eligible: false, reason });
  if (typeof terrain !== 'string' || !/^[0-3]{2500}$/.test(terrain) || !Array.isArray(objects)) return reject('incomplete terrain or object data');
  if (status?.status !== 'normal') return reject('room not open');
  const controller = objects.find(o => o.type === 'controller');
  const sources = objects.filter(o => o.type === 'source');
  if (!controller || !sources.length) return reject('no controller or sources');
  if (controller.user || controller.reservation || objects.some(o => o.type === 'spawn' || o.type === 'keeperLair' || (o.user && o.type === 'creep'))) return reject('owned, reserved, or hostile room');
  const occupied = new Set(objects.filter(o => !['road', 'container'].includes(o.type)).map(o => o.y * 50 + o.x));
  const pass = i => !(Number(terrain[i]) & 1) && !occupied.has(i);
  function distances(target) {
    const dist = new Int16Array(2500).fill(-1), queue = [];
    for (const i of adjacent(target.y * 50 + target.x)) if (pass(i)) { dist[i] = 0; queue.push(i); }
    for (let p = 0; p < queue.length; p++) for (const n of adjacent(queue[p])) {
      if (pass(n) && dist[n] < 0) { dist[n] = dist[queue[p]] + 1; queue.push(n); }
    }
    return dist;
  }
  const fields = [...sources, controller].map(distances);
  let best;
  for (let y = 5; y < 45; y++) for (let x = 5; x < 45; x++) {
    const i = y * 50 + x;
    if (terrain[i] !== '0' || !pass(i) || fields.some(d => d[i] < 2)) continue;
    const neighbors = adjacent(i).filter(pass);
    if (neighbors.length < 6) continue;
    let space = 0, swamp = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const n = (y + dy) * 50 + x + dx;
      if (pass(n)) { space++; if (Number(terrain[n]) & 2) swamp++; }
    }
    const sourceDistance = fields.slice(0, -1).reduce((s, d) => s + d[i], 0);
    const score = sources.length * 100 + space * 2 - sourceDistance * 2 - fields.at(-1)[i] - swamp;
    if (!best || score > best.score) best = { x, y, score, sourceDistance, controllerDistance: fields.at(-1)[i], space, swamp };
  }
  return best ? { room, eligible: true, ...best, sources: sources.length, noviceUntil: status.novice ?? null, limitations: ['terrain distances ignore fatigue', 'neighbor threats and expansion potential not surveyed'] } : reject('no connected spawn site with adequate space');
}
