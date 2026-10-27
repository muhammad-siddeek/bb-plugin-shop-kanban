import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";

const LABELER_FLAGS = [
  "-p",
  "--no-session",
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-mcp",
  "--thinking",
  "off",
];

function runLabeler(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.env.HOME || "/",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr });
    };
    child.on("error", (error) => {
      stderr += String(error);
      finish(-1);
    });
    child.on("close", finish);
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    complete: async ({ command, system, prompt, models, timeoutMs }, context) => {
      let lastError: string | null = null;
      for (const model of models) {
        const result = await runLabeler(command, [...LABELER_FLAGS, "--model", model, "--system-prompt", system, prompt], timeoutMs, context.signal);
        const text = result.stdout.trim();
        if (result.code === 0 && text) return { text, model, error: null };
        lastError = (result.stderr || result.stdout).trim().slice(-500) || `${command} exited with ${result.code}`;
        if (context.signal.aborted) break;
      }
      return { text: null, model: null, error: lastError };
    },
  },
});
