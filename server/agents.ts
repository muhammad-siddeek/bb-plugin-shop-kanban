import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PLUGIN_SLUG, TOOL_PREFIX } from "../brand";
import type { BoardTask } from "./schema";
import { SHORT_NAME_MAX } from "./text";

export type TaskSpawn = { shortName: string; prompt: string; projectId?: string; parentThreadId?: string };

type BoardApi = {
  listBoard(): Promise<{ columns: unknown[]; tasks: BoardTask[] }>;
  spawnTask(input: TaskSpawn): Promise<BoardTask>;
  removeTask(threadId: string, options?: { archiveThread?: boolean }): Promise<boolean>;
  parkTask(threadId: string, parked: boolean): Promise<BoardTask>;
};

const TOOLS = {
  spawnTask: `${TOOL_PREFIX}_spawn_task`,
  createTheoryTasks: `${TOOL_PREFIX}_create_theory_tasks`,
};

/**
 * Opens the board instructions that spawned threads' prompts carried after a `---` rule until 0.14.0. Followed by
 * "thread"; prompts from before 0.7.0 say "card", so `withoutToolHelp` strips both by this prefix.
 */
const TOOL_HELP_LEAD = "You are working on Kanban";

/** `text` without the board instructions appended to the prompt of a thread spawned before 0.14.0. */
export function withoutToolHelp(text: string): string {
  return text.split(`\n---\n${TOOL_HELP_LEAD} `)[0].trim();
}

export function registerAgentTools(bb: BbPluginApi, { spawnTask }: Pick<BoardApi, "spawnTask">) {
  bb.agents.registerTool({
    name: TOOLS.spawnTask,
    description: "Spawn a new BB thread on the Kanban board, usually as a child of the current thread.",
    instructions:
      "Call only when the user asks for a separate thread. Choose a shortName that describes the whole thread's goal. The board adds a 1-2 word bracketed category prefix and titles child threads parent > child, so keep names short. The board follows the thread's live state; nothing needs reporting back.",
    presentation: { label: { pending: "Spawning Kanban thread", completed: "Spawned Kanban thread" }, icon: { glyph: "Bot" } },
    parameters: z.object({
      shortName: z.string().min(1).max(40).describe("Short thread title describing the whole thread's goal."),
      prompt: z.string().min(1).max(12_000).describe("The new thread's first message."),
      parentThreadId: z.string().optional().describe("Parent thread id. Omit to use the current thread."),
    }),
    async execute(args, context) {
      const task = await spawnTask({ ...args, parentThreadId: args.parentThreadId ?? context.threadId });
      return `Spawned ${task.titleChain} as @thread:${task.threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: TOOLS.createTheoryTasks,
    description:
      "For an investigation thread, spawn one independent BB thread per theory so separate agents can try different solutions.",
    instructions:
      "Call only when the user asks to split an investigation into theory threads. Each theory needs a shortName that describes that theory thread's overall goal; the board adds a 1-2 word bracketed category prefix. The board follows each thread's live state; nothing needs reporting back.",
    presentation: { label: { pending: "Spawning theory threads", completed: "Spawned theory threads" }, icon: { glyph: "Lightbulb" } },
    parameters: z.object({
      parentThreadId: z.string().optional().describe("Investigation thread. Omit to use current thread."),
      theories: z
        .array(
          z.object({
            shortName: z.string().min(1).max(40).describe("Short title describing the whole theory thread's goal."),
            theory: z.string().min(1).max(4_000),
            prompt: z
              .string()
              .max(12_000)
              .optional()
              .describe("The thread's first message. Omit for one asking it to try the theory independently."),
          }),
        )
        .min(1)
        .max(12),
    }),
    async execute(args, context) {
      const parentThreadId = args.parentThreadId ?? context.threadId;
      const spawned: BoardTask[] = [];
      for (const theory of args.theories) {
        const prompt =
          theory.prompt?.trim() ||
          [
            `Try this theory independently: ${theory.theory}`,
            "Investigate or implement the smallest convincing test/solution.",
            "Do not assume another theory thread will do your work.",
            "End with whether the theory worked and why.",
          ].join("\n\n");
        spawned.push(await spawnTask({ shortName: theory.shortName, prompt, parentThreadId }));
      }
      return `Spawned ${spawned.length} theory thread(s): ${spawned
        .map((task) => `${task.titleChain} (@thread:${task.threadId})`)
        .join(", ")}.`;
    },
  });

  // Offered in every thread with no standing instructions: the board reads live thread state, so an agent spawns
  // board threads only when the user asks.
  bb.agents.configure(() => ({ tools: Object.values(TOOLS), skills: [PLUGIN_SLUG] }));
}

export function registerCli(bb: BbPluginApi, { listBoard, spawnTask, removeTask, parkTask }: BoardApi) {
  const cli = `bb ${PLUGIN_SLUG}`;
  const commands = [
    { name: "list", summary: "List threads on the Kanban board", usage: `${cli} list [--json]` },
    { name: "add", summary: "Spawn a thread on the Kanban board", usage: `${cli} add <short-name> -- <prompt> [--json]` },
    { name: "park", summary: "Park an idle thread for later", usage: `${cli} park <thread-id> [--json]` },
    { name: "unpark", summary: "Take a thread out of Parked", usage: `${cli} unpark <thread-id> [--json]` },
    { name: "remove", summary: "Archive/remove a thread from the board", usage: `${cli} remove <thread-id> [--json]` },
  ];
  const usage = ["Usage:", ...commands.map((command) => `  ${command.usage}`)].join("\n");
  bb.cli.register({
    name: PLUGIN_SLUG,
    summary: "Manage the Kanban board of BB threads",
    commands,
    async run(argv: string[]) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command] = args;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const usageError = { exitCode: 1, stderr: usage };
      try {
        if (command === "list") {
          const board = await listBoard();
          const lines = board.tasks.map(
            (task) =>
              `${task.threadId}\t${task.status}\t${task.titleChain}${task.statusReason ? ` (${task.statusReason})` : ""}${task.note ? ` — ${task.note}` : ""}`,
          );
          return reply(board, lines.length ? lines.join("\n") : "No threads on the Kanban board yet.");
        }
        if (command === "add") {
          const separator = args.indexOf("--");
          if (separator <= 1) return usageError;
          const shortName = args.slice(1, separator).join(" ");
          const prompt = args.slice(separator + 1).join(" ");
          if (!prompt.trim()) return usageError;
          // The spawn tools' limit: a longer name is refused rather than cut.
          if (shortName.trim().length > SHORT_NAME_MAX) {
            return { exitCode: 1, stderr: `The short name is ${shortName.trim().length} characters; the limit is ${SHORT_NAME_MAX}.` };
          }
          const task = await spawnTask({ shortName, prompt });
          return reply(task, `Spawned ${task.titleChain} as ${task.threadId}`);
        }
        if (command === "park" || command === "unpark") {
          const [, threadId] = args;
          if (!threadId) return usageError;
          const task = await parkTask(threadId, command === "park");
          return reply(task, `${command === "park" ? "Parked" : "Unparked"} ${task.titleChain} (${task.status})`);
        }
        if (command === "remove") {
          const [, threadId] = args;
          if (!threadId) return usageError;
          const removed = await removeTask(threadId, { archiveThread: true });
          if (!removed) return { exitCode: 1, stderr: `Could not archive thread ${threadId}.` };
          return reply({ removed }, `Archived ${threadId} from the board`);
        }
        return command === undefined || command === "help" || command === "--help" ? { exitCode: 0, stdout: usage } : usageError;
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
