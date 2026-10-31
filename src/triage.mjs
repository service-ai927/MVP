import { triageThread } from "./ai-service.mjs";

export async function triage(thread, options = {}) {
  return triageThread(thread, options);
}

/**
 * Whether an automatic (bulk) triage pass may process this thread.
 * Never silently overwrites a human decision: once a classification was
 * saved by an operator (decided_by === "human"), only the explicit
 * per-thread "再振り分け" action may re-run triage on it.
 * Missing classification objects are treated as untriaged (pending).
 */
export function shouldAutoTriage(thread) {
  if (!thread) return false;
  if (thread.classification?.decided_by === "human") return false;
  return (
    thread.classification?.action === "pending" ||
    thread.thread?.status === "open" ||
    thread.thread?.status === "New"
  );
}
