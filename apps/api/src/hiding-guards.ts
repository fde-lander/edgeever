/**
 * Write guard helper — rejects agent writes to hidden notebooks.
 *
 * Used by shared write primitives (createMemoRecord, updateMemoRecord, etc.)
 * to check if the target notebook is hidden for the current agent token.
 * Session (user) requests have no hiding set → guard is a no-op.
 */
import { getHidingSet } from "./mcp-hiding";
import type { DatabaseAdapter } from "./storage-contract";

export class HiddenNotebookError extends Error {
  constructor(notebookId: string) {
    super(`This notebook is restricted. You do not have permission to access notebook "${notebookId}".`);
    this.name = "HiddenNotebookError";
  }
}

/**
 * Assert that a notebook is NOT hidden for the current request.
 * Throws HiddenNotebookError if the notebook is in the hiding set.
 * No-op for session requests (no hiding set attached).
 */
export const assertNotebookWritable = (
  db: DatabaseAdapter,
  notebookId: string,
): void => {
  const hiddenIds = getHidingSet(db);
  if (hiddenIds && hiddenIds.has(notebookId)) {
    throw new HiddenNotebookError(notebookId);
  }
};

/**
 * Assert that multiple notebooks are NOT hidden.
 * Checks each ID; throws on first hidden one found.
 */
export const assertNotebooksWritable = (
  db: DatabaseAdapter,
  notebookIds: string[],
): void => {
  const hiddenIds = getHidingSet(db);
  if (!hiddenIds) return; // session request, no hiding
  for (const id of notebookIds) {
    if (hiddenIds.has(id)) {
      throw new HiddenNotebookError(id);
    }
  }
};
