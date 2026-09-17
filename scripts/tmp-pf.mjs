// 一次性实验:直接驱动 native pathfinder,验证跨房 search。用完即删。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireEngine = createRequire(resolve('.engine/package.json'));
const native = requireEngine('@screeps/driver/native/build/Release/native.node');

// 复刻 driver/lib/path-finder.js 的坐标换算与 init
const kWorldSize = 255;
function parseRoomName(roomName) {
  const room = /^([WE])([0-9]+)([NS])([0-9]+)$/.exec(roomName);
  const rx = (kWorldSize >> 1) + (room[1] === 'W' ? -Number(room[2]) : Number(room[2]) + 1);
  const ry = (kWorldSize >> 1) + (room[3] === 'N' ? -Number(room[4]) : Number(room[4]) + 1);
  return { xx: rx, yy: ry };
}
const plains = '0'.repeat(2500);
const packBits = (terrain) => {
  const pack = new Uint8Array(50 * 50 / 4);
  for (let xx = 0; xx < 50; ++xx) for (let yy = 0; yy < 50; ++yy) {
    const ii = xx * 50 + yy;
    const bit = Number(terrain[yy * 50 + xx]);
    pack[ii / 4 | 0] = pack[ii / 4 | 0] & ~(0x03 << ii % 4 * 2) | bit << ii % 4 * 2;
  }
  return pack;
};
const rooms = ['W0N1', 'W0N2', 'W1N1', 'W1N2', 'W0N3'].map(name => ({ room: parseRoomName(name), bits: packBits(plains) }));
native.loadTerrain(rooms);
console.log('loadTerrain OK for', rooms.length, 'rooms');

const origin = { xx: parseRoomName('W0N1').xx * 50 + 25, yy: parseRoomName('W0N1').yy * 50 + 25 };
// toWorldPosition: 看 path-finder.js 的换算——xx*50+x? 打印确认
console.log('origin wp:', origin);
const goalPos = { xx: parseRoomName('W0N2').xx * 50 + 25, yy: parseRoomName('W0N2').yy * 50 + 25 };
const goals = [{ range: 22, pos: goalPos }];
try {
  const ret = native.search(origin, goals, undefined, 1, 5, 16, 2000, 0xffffffff, false, 1.2);
  console.log('search ret:', ret === undefined ? 'undefined' : ret === -1 ? 'incomplete' : { ops: ret.ops, cost: ret.cost, pathLen: ret.path.length, tail: ret.path.slice(0, 3) });
} catch (e) {
  console.log('search THREW:', e.message);
}
process.exit(0);
