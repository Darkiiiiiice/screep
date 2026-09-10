/**
 * Stream the live console.
 *
 * This is the default observation channel because it is the cheapest: websocket
 * events are NOT covered by the HTTP rate limits (the token simply has to be
 * granted console events when it is created). `GET /api/user/memory` allows
 * only 1 request/minute and `POST /api/user/code` only 240/day, so keeping
 * day-to-day watching on the socket preserves the metered budget for when it
 * is actually needed.
 *
 * Also mirrors the feed to console.log lines under logs/, so a session can be
 * reviewed after the fact.
 *
 * Usage:
 *   node scripts/watch.mjs [--seconds N]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScreepsSocketClient } from 'screeps-api';
import { connect } from './lib/client.mjs';

const args = process.argv.slice(2);
const secFlag = args.indexOf('--seconds');
const seconds = secFlag !== -1 ? Number(args[secFlag + 1]) : 0; // 0 = run forever

const { api, shard, shardSource } = await connect('watch');

const socket = new ScreepsSocketClient(api);

const logFile = resolve(process.cwd(), 'logs', 'console.log');
mkdirSync(resolve(process.cwd(), 'logs'), { recursive: true });

function stamp() {
  return new Date().toISOString();
}

function emit(line) {
  process.stdout.write(`${line}\n`);
  appendFileSync(logFile, `${line}\n`);
}

emit(`[watch] shard ${shard} (${shardSource}); streaming console — no HTTP quota consumed`);
emit(`[watch] mirroring to ${logFile}`);

socket.on(ScreepsSocketClient.CONNECTED, () => emit(`[watch] ${stamp()} websocket connected`));
socket.on(ScreepsSocketClient.DISCONNECTED, () => emit(`[watch] ${stamp()} websocket disconnected`));
socket.on(ScreepsSocketClient.AUTH, (ev) =>
  emit(`[watch] ${stamp()} auth: ${ev?.data?.status ?? 'unknown'}`),
);
socket.on(ScreepsSocketClient.ERROR, (err) =>
  emit(`[watch] ${stamp()} socket error: ${err?.message ?? err}`),
);

socket.on('console', (event) => {
  // Console events arrive as a batch per tick. The payload is
  // `{ messages: { log: string[], results: [] }, shard }` — there is no
  // `gameTime` field, because the game time is already embedded in each log
  // line (our logger prefixes it). Reading a non-existent field is what made an
  // earlier version print `[?]` for every line.
  const messages = event?.data?.messages ?? {};
  const shardName = event?.data?.shard ?? shard;

  for (const channel of Object.keys(messages)) {
    for (const line of messages[channel] ?? []) {
      emit(`[${shardName}] ${line}`);
    }
  }
});

await socket.subscribeUserConsole();
await socket.connect();

if (seconds > 0) {
  setTimeout(() => {
    emit(`[watch] ${stamp()} reached --seconds ${seconds}, disconnecting`);
    socket.disconnect();
    process.exit(0);
  }, seconds * 1000).unref?.();
}

// Keep the process alive until a signal or the --seconds timer fires.
process.on('SIGINT', () => {
  emit(`[watch] ${stamp()} interrupted`);
  socket.disconnect();
  process.exit(0);
});
