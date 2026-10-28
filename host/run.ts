import { spawn } from "cross-spawn";
import { homedir } from "node:os";

export type RunResult = { code: number | null; stdout: string; stderr: string };

/** Output past this is dropped; every caller reads bounded JSON or text. */
const STDOUT_MAX = 2_000_000;
const STDERR_MAX = 20_000;

/**
 * Runs `command` from the home directory and resolves when it exits; never rejects. A command that cannot start
 * resolves with code -1. cross-spawn resolves Windows npm shims (`qmd.cmd`) and quotes their args for cmd.exe;
 * elsewhere it is plain `spawn`.
 */
export function run(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_MAX) stderr += chunk;
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

/** The tail of what a failed command printed, for an error message. */
export function failure(command: string, result: RunResult): string {
  return (result.stderr || result.stdout).trim().slice(-500) || `${command} exited with ${result.code}`;
}
