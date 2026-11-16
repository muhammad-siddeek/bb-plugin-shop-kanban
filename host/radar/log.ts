import { safeMessage } from "./runtime";

/** Stage timing in the host/automation log, without credential-bearing backend details. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    console.error(`[radar] ${safeMessage(label)}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
}
