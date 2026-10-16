import { triageThread } from "./ai-service.mjs";

export async function triage(thread, options = {}) {
  return triageThread(thread, options);
}
