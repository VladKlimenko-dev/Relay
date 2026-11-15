// All saved sessions are eligible for reopening, including stopped/completed/failed ones.
export function sessionToRestore<T extends { id: number; savedAt?: string; createdAt: string }>(
  sessions: T[], rememberedId?: string | null,
): T | undefined {
  const remembered = rememberedId ? sessions.find(s => s.id === Number(rememberedId)) : undefined;
  return remembered || [...sessions].sort((a, b) =>
    (b.savedAt || b.createdAt).localeCompare(a.savedAt || a.createdAt) || b.id - a.id)[0];
}
