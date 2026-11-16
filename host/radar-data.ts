import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { radarDigestSchema } from "../server/radar-schema";
import { normalizeDigest } from "./radar/index";

export const radarDataDir = (dataDir: string) => join(dataDir, "radar");

export async function radarSnapshot(dataDir: string) {
  const dir = radarDataDir(dataDir);
  try {
    return radarDigestSchema.parse(normalizeDigest(JSON.parse(await readFile(join(dir, "latest.json"), "utf8"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Older installations kept dated digests; promote the newest complete one once.
  let names: string[];
  try { names = await readdir(join(dir, "digests")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  for (const name of names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().reverse()) {
    const parsed = radarDigestSchema.safeParse(normalizeDigest(JSON.parse(await readFile(join(dir, "digests", name), "utf8"))));
    if (!parsed.success) continue;
    await writeFile(join(dir, "latest.json"), JSON.stringify(parsed.data));
    return parsed.data;
  }
  return null;
}

/** Explicit one-time copy; never reads the old checkout during normal operation. */
export async function importRadarData(dataDir: string, source: string) {
  if (!isAbsolute(source) || !(await stat(source)).isDirectory()) throw new Error("Radar import needs an absolute data directory.");
  const destination = radarDataDir(dataDir);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
  return { digest: await radarSnapshot(dataDir), dataDir: destination };
}
