/**
 * Engine type augmentations.
 *
 * `@types/screeps` declares `CreepMemory` as an empty interface, because the
 * engine itself does not care what memory shape a player uses. Our AI does, so
 * the shape is declared once here rather than cast at every read.
 *
 * Keeping this in one file means the Memory contract is visible in a single
 * place — which matters because Memory is the only state that survives a runtime
 * restart, and every field added here is a permanent commitment to a schema
 * (see `src/kernel/memory.ts` for the version that gates migrations).
 */

interface CreepMemory {
  /** Role this creep was spawned for. Fixed for the creep's lifetime. */
  role?: string;
  /** Task currently leased to this creep, if any. */
  taskId?: string;
  /** Room this creep was spawned to serve, for cross-room logistics. */
  home?: string;
}
