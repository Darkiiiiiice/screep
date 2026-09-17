// 一次性实验:本地引擎双房跨房移动验证。用完即删。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

const requireEngine = createRequire(resolve('.engine/package.json'));
const { ScreepsServer, TerrainMatrix } = requireEngine('screeps-server-mockup');

const output = resolve('artifacts/scenarios', `xroom-${Date.now()}`);
mkdirSync(output, { recursive: true });
const freePort = await new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = new ScreepsServer({ path: resolve(output, 'server'), logdir: resolve(output, 'logs'), port: Number(process.env.SCREEPS_TEST_PORT ?? freePort) });
await server.world.reset();
await server.world.addRoom('W0N1');
await server.world.setTerrain('W0N1', new TerrainMatrix());
await server.world.addRoom('W0N2');
await server.world.setTerrain('W0N2', new TerrainMatrix());
await server.world.addRoomObject('W0N1', 'controller', 10, 12, { level: 0 });
await server.world.addRoomObject('W0N2', 'controller', 10, 12, { level: 0 });
const bot = await server.world.addBot({ username: 'X', room: 'W0N1', x: 25, y: 25, modules: { main: `
module.exports.loop = function() {
  Memory.xroom = Memory.xroom || [];
  const names = Object.keys(Game.creeps);
  if (!names.length) { const sp = Game.spawns[Object.keys(Game.spawns)[0]]; const rc = sp && !sp.spawning ? sp.spawnCreep([MOVE], 'x') : 'busy'; if (Game.time % 10 === 0 || rc === 0) Memory.xroom.push('T' + Game.time + ' spawn=' + rc); return; }
  const c = Game.creeps[names[0]];
  if (c.spawning) { Memory.xroom.push('T' + Game.time + ' spawning'); return; }
  if (Game.time === 4) {
    try { const t = Game.map.getRoomTerrain('W0N2'); Memory.xroom.push('getRoomTerrain W0N2 OK: ' + t.get(25, 25)); } catch (e) { Memory.xroom.push('getRoomTerrain W0N2 THROW: ' + (e && e.message)); }
    try { const t2 = Game.map.getRoomTerrain('W0N1'); Memory.xroom.push('getRoomTerrain W0N1 OK: ' + t2.get(25, 25)); } catch (e) { Memory.xroom.push('getRoomTerrain W0N1 THROW: ' + (e && e.message)); }
    try { const r2 = PathFinder.search(new RoomPosition(25, 25, 'W0N1'), { pos: new RoomPosition(25, 25, 'W0N2'), range: 22 }, { roomCallback: (rn) => { Memory.xroom.push('cb room=' + rn); return undefined; } }); Memory.xroom.push('PF direct: len=' + r2.path.length + ' incomplete=' + r2.incomplete); } catch (e) { Memory.xroom.push('PF direct THROW: ' + (e && e.message)); }
    try {
      const cm = new PathFinder.CostMatrix();
      const r3 = PathFinder.search(new RoomPosition(25, 25, 'W0N1'), { pos: new RoomPosition(25, 25, 'W0N2'), range: 22 }, { plainCost: 2, swampCost: 10, maxOps: 20000, roomCallback: (rn) => { Memory.xroom.push('cb2 room=' + rn); return cm; } });
      Memory.xroom.push('PF roomsjs-style: len=' + r3.path.length + ' incomplete=' + r3.incomplete);
    } catch (e) { Memory.xroom.push('PF roomsjs-style THROW: ' + (e && e.message)); }
  }
  let r; try { r = c.moveTo(new RoomPosition(25, 25, 'W0N2'), { range: 22, reusePath: 0 }); } catch (e) { Memory.xroom.push('T' + Game.time + ' THROW ' + (e && e.message) + ' | ' + String(e && e.stack).slice(0, 200)); return; }
  const route = Game.map.findRoute(c.room.name, 'W0N2');
  Memory.xroom.push('T' + Game.time + ' pos=' + c.room.name + ':' + c.pos.x + ',' + c.pos.y + ' moveTo=' + r + ' fatigue=' + c.fatigue + ' route=' + JSON.stringify(route));
};` } });
await server.start();
for (let i = 0; i < 140; i++) await server.tick();
const mem = JSON.parse(await bot.memory || '{}');
import zlib from 'node:zlib';
const { env } = server.common.storage;
const compressed = await env.get(env.keys.TERRAIN_DATA);
const terrain = JSON.parse(zlib.inflateSync(Buffer.from(compressed, 'base64')).toString());
console.log('terrain rooms:', terrain.map(t => t.room));
const objects = await server.world.roomObjects('W0N2');

for (const line of (mem.xroom ?? []).slice(0, 40)) console.log(line);
console.log('roomB creeps:', objects.filter(o => o.type === 'creep').map(o => [o.name, o.x, o.y]));
process.exit(0);
