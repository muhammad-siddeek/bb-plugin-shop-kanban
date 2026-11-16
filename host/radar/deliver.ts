// Publish the full digest to the Radar canvas, then a one-line Slack workflow DM linking to it.
// Without a canvas, send the full plain-text digest; without a working webhook, save a self-DM draft.
import { publishToCanvas } from "./canvas";
import { CONFIG } from "./config";
import { renderCanvas, renderPlain, renderSlack, renderSummary, splitLines, type Digest } from "./digest";
import { lit, runCode } from "./gateway";
import { rememberSecret, safeMessage, secretCommand, throwIfAborted, withTimeout } from "./runtime";

const SECURITY = "/usr/bin/security";
// Preserve the standalone app's identity so existing connections work after migration.
const KEYCHAIN = { service: "centaurs-radar-slack-webhook", account: "centaurs-radar" };
const WEBHOOK_MAX_CHARS = 3000;
const WORKFLOW_HOOK = /^https:\/\/hooks\.slack\.com\/triggers\/\S+$/;

/** Tool Gateway can only create drafts (no send); used when no webhook is connected or the ping failed. */
export async function draftToSlack(text: string): Promise<void> {
  await runCode<unknown>(`
await slack.who_am_i();
return await slack.send_message_draft(${lit(text)}, { channel_id: ${lit(CONFIG.me.slackId)} });`);
}

async function storedWebhook(): Promise<string | undefined> {
  try {
    const url = await secretCommand(SECURITY, ["find-generic-password", "-s", KEYCHAIN.service, "-w"], "Slack webhook is not connected");
    rememberSecret(url);
    return url || undefined;
  } catch {
    throwIfAborted();
    return undefined;
  }
}

async function postWebhook(url: string, payload: object): Promise<void> {
  rememberSecret(url);
  await withTimeout(30_000, async (signal) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const body = await res.text();
    if (!res.ok || reportsFailure(body)) throw new Error(`Slack webhook HTTP ${res.status}: ${safeMessage(body).slice(0, 200)}`);
  });
}

/** Slack answers `{"ok":false,...}` for rejected payloads; non-JSON bodies carry no verdict. */
function reportsFailure(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === false;
}

/** Validate with a test ping; store only a working URL, under the existing login Keychain identity. */
export async function connectWebhook(url: string): Promise<string> {
  if (!WORKFLOW_HOOK.test(url)) throw new Error("Expected a Slack workflow trigger URL (https://hooks.slack.com/triggers/…)");
  rememberSecret(url);
  await postWebhook(url, { digest: "Centaurs Radar is connected. Your daily digest will arrive here." });
  await secretCommand(SECURITY, ["add-generic-password", "-U", "-a", KEYCHAIN.account, "-s", KEYCHAIN.service, "-w", url], "Could not store the Slack webhook in the login Keychain");
  return `test ping sent; webhook stored in Keychain item "${KEYCHAIN.service}"`;
}

/** Canvas first; its failure falls back to the full digest, split only between complete items. */
export async function deliver(digest: Digest): Promise<void> {
  let canvasUrl = "";
  try {
    canvasUrl = await publishToCanvas(renderCanvas(digest));
    console.log(`digest added to the canvas: ${safeMessage(canvasUrl)}`);
  } catch (error) {
    throwIfAborted();
    console.error(`canvas update failed: ${safeMessage(error)}; the DM carries the whole digest`);
  }
  const webhook = await storedWebhook();
  if (webhook) {
    const parts = splitLines(canvasUrl ? renderSummary(digest, canvasUrl) : renderPlain(digest), WEBHOOK_MAX_CHARS);
    try {
      for (const part of parts) await postWebhook(webhook, { digest: part });
      console.log(`DM sent (${parts.length} message${parts.length === 1 ? "" : "s"})`);
      return;
    } catch (error) {
      throwIfAborted();
      console.error(`slack webhook failed: ${safeMessage(error)}; saving a Slack draft instead`);
    }
  }
  // A failed draft fails the run unless the canvas already holds the complete digest.
  try {
    await draftToSlack(canvasUrl ? renderSummary(digest, canvasUrl) : renderSlack(digest));
    console.log("DM saved as a Slack draft in your self-DM");
  } catch (error) {
    throwIfAborted();
    if (!canvasUrl) throw error;
    console.error(`slack draft failed: ${safeMessage(error)}`);
  }
}
