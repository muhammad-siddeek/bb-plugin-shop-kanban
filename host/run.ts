import { spawn } from "cross-spawn";
import type { ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable } from "node:stream";

export type RunResult = { code: number | null; stdout: string; stderr: string };

/** Output past this is dropped; every caller reads bounded JSON or text. */
const STDOUT_MAX = 2_000_000;
const STDERR_MAX = 20_000;
/**
 * How long a stopped command gets to exit before it is killed and given up on. Short enough to stay inside the
 * server's 5s margin over the host timeouts.
 */
const KILL_AFTER_MS = 1_000;

/** The user's home directory; null when the OS names none (no HOME and no passwd entry). */
export function homeDir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

/**
 * Runs `command` from the home directory and resolves when it exits or is stopped; never rejects. A command that
 * cannot start resolves with code -1, a stopped one with code null. cross-spawn resolves Windows npm shims
 * (`qmd.cmd`) and quotes their args for cmd.exe; elsewhere it is plain `spawn`.
 */
export function run(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const home = homeDir();
      // A daemon started without HOME still gives the CLIs their config dirs (gh reads ~/.config/gh).
      const env = home && !process.env.HOME ? { ...process.env, HOME: home } : process.env;
      // Spawning in a missing cwd fails with ENOENT, which reads as a command that is not installed.
      child = spawn(command, args, { cwd: home && existsSync(home) ? home : undefined, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // Invalid arguments (an empty command, a NUL byte in a prompt) throw instead of emitting "error".
      resolve({ code: -1, stdout: "", stderr: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      // A background process it left behind may still hold the pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout, stderr });
    };
    // A command that ignores SIGTERM, or whose background process keeps the pipes open, never closes on its own.
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(child.exitCode);
      }, KILL_AFTER_MS);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    // Decode as a stream: a multi-byte character split across chunks stays whole.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr += chunk;
    });
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
