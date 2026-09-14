import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

it('rejects engine globals and adapter imports from pure decisions while allowing adapters', async () => {
  const eslint = new ESLint();
  const [domain] = await eslint.lintText("import { read } from '../../game/read'; export const tick = () => read(Game.time);", { filePath: 'src/domain/planning/probe.ts' });
  expect(domain?.messages.some((message) => message.ruleId === 'no-restricted-globals')).toBe(true);
  expect(domain?.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  const [adapter] = await eslint.lintText('export const time = () => Game.time;', { filePath: 'src/game/probe.ts' });
  expect(adapter?.errorCount).toBe(0);
});
