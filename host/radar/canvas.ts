// Slack canvas delivery: each digest, with inline links, goes to the top of one "Radar" canvas, right below a fixed
// intro line (newest first; older digests stay below). The canvas is created on first use and its id kept in
// data/canvas.json.
import { CONFIG, PATHS } from "./config";
import { lit, runCode } from "./gateway";
import { readJson, writeJson } from "./store";

interface CanvasRef {
  id: string;
  url: string;
}

// Each digest is appended right after this paragraph, so the newest is always on top.
const ANCHOR = "Daily digest, newest first.";
// Canvas writes refuse mentions outright; digest text quotes Slack and LLM output, so strip them.
const MENTIONS = /<[@!#][^>]*>|@(here|channel|everyone)\b/g;

async function create(): Promise<CanvasRef> {
  const r = await runCode<{ canvas_id: string; canvas_url: string }>(`
await slack.who_am_i();
return await slack.create_canvas(${lit(CONFIG.canvasTitle)}, ${lit(ANCHOR)});`);
  const ref = { id: r.canvas_id, url: r.canvas_url };
  writeJson(PATHS.canvas, ref);
  return ref;
}

/** Append below the intro line; false when the canvas or its intro line is gone. */
async function appendBelowAnchor(id: string, content: string): Promise<boolean> {
  return runCode<boolean>(`
await slack.who_am_i();
let canvas: { section_id_mapping?: Record<string, string> };
try {
  canvas = (await slack.read_canvas(${lit(id)})) as unknown as typeof canvas;
} catch (e) {
  if (/not.?found|deleted/i.test(String(e))) return false;
  throw e;
}
const anchor = Object.entries(canvas.section_id_mapping ?? {}).find(([, text]) => text.trim() === ${lit(ANCHOR)})?.[0];
if (!anchor) return false;
await slack.update_canvas(${lit(id)}, 'append', ${lit(content)}, anchor);
return true;`);
}

/** Put `markdown` at the top of the Radar canvas; returns the canvas link. */
export async function publishToCanvas(markdown: string): Promise<string> {
  const content = markdown.replace(MENTIONS, "");
  const ref = readJson<CanvasRef | null>(PATHS.canvas, null) ?? (await create());
  if (await appendBelowAnchor(ref.id, content)) return ref.url;
  // Deleted canvas or removed intro line: start a new canvas rather than guess where the top is.
  const fresh = await create();
  if (!(await appendBelowAnchor(fresh.id, content))) throw new Error(`new canvas ${fresh.url} has no intro line`);
  return fresh.url;
}
