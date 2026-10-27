import { z } from "zod";
import { PLUGIN_NAME, PLUGIN_SLUG, TOOL_PREFIX } from "../brand";
import { COLUMN_IDS, COLUMNS, columnSchema, type BoardTask, type Column, type Result } from "./schema";

type BoardApi = {
  listBoard(): Promise<{ columns: unknown[]; tasks: BoardTask[] }>;
  spawnTask(input: { shortName: string; prompt: string; projectId?: string; parentThreadId?: string; column?: Column; showOnBoard?: boolean }): Promise<BoardTask>;
  updateTask(input: { threadId: string; column?: Column; shortName?: string; note?: string; result?: Result | null; showOnBoard?: boolean; showChildren?: boolean }): Promise<BoardTask>;
  markTaskResult(threadId: string, success: boolean, summary: string): Promise<{ task: BoardTask; result: Result }>;
  removeTask(threadId: string, options?: { archiveThread?: boolean }): Promise<boolean>;
};

const TOOLS = {
  moveCard: `${TOOL_PREFIX}_move_card`,
  spawnTask: `${TOOL_PREFIX}_spawn_task`,
  createTheoryTasks: `${TOOL_PREFIX}_create_theory_tasks`,
  markResult: `${TOOL_PREFIX}_mark_result`,
};

const NO_THREAD_ID = "No current thread id was available; pass threadId explicitly.";

export function toolHelp(titleChain: string): string {
  return [
    `You are working on Kanban card ${JSON.stringify(titleChain)}.`,
    `Move the card as work progresses with ${TOOLS.moveCard}. Columns are Queue, WIP, Blocked, and Done.`,
    `When you finish, call ${TOOLS.markResult} with success=true or success=false and a short summary.`,
    "Task titles should describe the whole conversation goal, not the latest implementation step.",
    "Task descriptions/notes should describe how far the work has gotten and what changed most recently.",
    "The board categorizes task titles holistically and prefixes them with a 1-2 word bracketed category such as [docs site].",
    "When spawning from a parent task, titles are formatted as parent > child, so keep each segment short.",
  ].join("\n");
}

export function registerAgentTools(bb: any, { spawnTask, updateTask, markTaskResult }: BoardApi) {
  bb.agents.registerTool({
    name: TOOLS.moveCard,
    description: "Move the current or specified Kanban board thread card to another column as work progresses.",
    instructions:
      "Use this when your task state changes. If no threadId is supplied, it updates the current thread. Columns: queue, wip, blocked, done.",
    presentation: { label: { pending: "Moving Kanban card", completed: "Moved Kanban card" }, icon: { glyph: "ListTodo" } },
    parameters: z.object({
      threadId: z.string().optional().describe("Thread/card id. Omit to update the current thread."),
      column: columnSchema,
      note: z
        .string()
        .max(2_000)
        .optional()
        .describe("Progress/status description: how far the work has gotten and what changed most recently."),
      shortName: z
        .string()
        .max(40)
        .optional()
        .describe("Short task title describing the whole conversation goal, not just the latest step."),
      showChildren: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
    }),
    async execute(args: any, context: any) {
      const threadId = args.threadId ?? context.threadId;
      if (!threadId) return NO_THREAD_ID;
      const task = await updateTask({
        threadId,
        column: args.column,
        note: args.note,
        shortName: args.shortName,
        showChildren: args.showChildren,
      });
      return `Moved ${task.titleChain} to ${COLUMNS[args.column as Column].title}.`;
    },
  });

  bb.agents.registerTool({
    name: TOOLS.spawnTask,
    description: "Spawn a new BB thread as a Kanban card, usually as a child of the current card.",
    instructions:
      "Choose a shortName that describes the whole conversation goal, not just the latest step. The board will add a 1-2 word bracketed category prefix based on all board tasks. Child cards are titled parent > child, so keep names short.",
    presentation: { label: { pending: "Spawning Kanban task", completed: "Spawned Kanban task" }, icon: { glyph: "Bot" } },
    parameters: z.object({
      shortName: z.string().min(1).max(40).describe("Short task title describing the whole conversation goal."),
      prompt: z.string().min(1).max(12_000).describe("Initial prompt/progress description for the task."),
      parentThreadId: z.string().optional().describe("Parent thread id. Omit to use the current thread."),
      column: columnSchema.optional(),
      showOnBoard: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
    }),
    async execute(args: any, context: any) {
      const parentThreadId = args.parentThreadId ?? context.threadId ?? undefined;
      const task = await spawnTask({ ...args, parentThreadId });
      return `Spawned ${task.titleChain} as @thread:${task.threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: TOOLS.createTheoryTasks,
    description:
      "For an investigation card, spawn one independent BB thread/card per theory so separate agents can try different solutions.",
    instructions:
      "Use after investigating and forming theories. Each theory needs a shortName that describes that theory task's overall goal, not just the latest step. The board will add a 1-2 word bracketed category prefix based on all board tasks. Each spawned agent should try that theory independently and mark success/failure.",
    presentation: { label: { pending: "Spawning theory tasks", completed: "Spawned theory tasks" }, icon: { glyph: "Lightbulb" } },
    parameters: z.object({
      parentThreadId: z.string().optional().describe("Investigation thread. Omit to use current thread."),
      showOnBoard: z.boolean().optional().describe("Deprecated; the board only shows top-level non-archived cards."),
      theories: z
        .array(
          z.object({
            shortName: z.string().min(1).max(40).describe("Short title describing the whole theory task goal."),
            theory: z.string().min(1).max(4_000),
            prompt: z
              .string()
              .max(12_000)
              .optional()
              .describe("Progress/task prompt shown as the card description until updates arrive."),
          }),
        )
        .min(1)
        .max(12),
    }),
    async execute(args: any, context: any) {
      const parentThreadId = args.parentThreadId ?? context.threadId ?? undefined;
      if (parentThreadId) {
        await updateTask({ threadId: parentThreadId, column: "wip", note: `Spawned ${args.theories.length} theory task(s).` });
      }
      const spawned: BoardTask[] = [];
      for (const theory of args.theories) {
        const prompt =
          theory.prompt?.trim() ||
          [
            `Try this theory independently: ${theory.theory}`,
            "Investigate or implement the smallest convincing test/solution.",
            "Do not assume another theory task will do your work.",
            `When done, call ${TOOLS.markResult} with success=true if the theory worked, otherwise success=false, and include a concise summary.`,
          ].join("\n\n");
        spawned.push(
          await spawnTask({
            shortName: theory.shortName,
            prompt,
            parentThreadId,
            column: "wip",
            showOnBoard: args.showOnBoard === true,
          }),
        );
      }
      return `Spawned ${spawned.length} theory task(s): ${spawned
        .map((task) => `${task.titleChain} (@thread:${task.threadId})`)
        .join(", ")}.`;
    },
  });

  bb.agents.registerTool({
    name: TOOLS.markResult,
    description: "Mark the current or specified Kanban card as done or blocked when the agent finishes.",
    instructions:
      "Always call this when finishing a Kanban task. Include a concise summary. Success moves to Done; failure moves to Blocked.",
    presentation: { label: { pending: "Marking Kanban result", completed: "Marked Kanban result" }, icon: { glyph: "CircleCheck" } },
    parameters: z.object({
      threadId: z.string().optional().describe("Thread/card id. Omit to update current thread."),
      success: z.boolean(),
      summary: z
        .string()
        .min(1)
        .max(2_000)
        .describe("Final progress description: how far the work got and why it is done or blocked."),
    }),
    async execute(args: any, context: any) {
      const threadId = args.threadId ?? context.threadId;
      if (!threadId) return NO_THREAD_ID;
      const { task, result } = await markTaskResult(threadId, args.success, args.summary);
      return `Marked ${task.titleChain} as ${result}: ${args.summary}`;
    },
  });

  bb.agents.configure(() => ({
    tools: Object.values(TOOLS),
    skills: [PLUGIN_SLUG],
    instructions: [
      `${PLUGIN_NAME} plugin workflow:`,
      `- Treat Kanban cards as BB threads. Move your card between columns with ${TOOLS.moveCard} as work progresses.`,
      `- For investigation work, produce theories, then call ${TOOLS.createTheoryTasks} so each theory gets an independent BB thread/agent. The board only shows top-level non-archived cards; child/sub-task threads are tracked but hidden from the board.`,
      "- A card title should describe the whole conversation goal, not the latest implementation step.",
      "- A card description/note should describe how far the work has gotten and what changed most recently.",
      "- Look at the board holistically and group related tasks with a 1-2 word bracketed category prefix, for example [docs site]. The board also auto-adds this prefix for new tasks when missing.",
      "- When a BB session spawns another, the child title is parent > child. Keep each segment short (usually 2-5 words).",
      `- The board columns are Queue, WIP, Blocked, and Done. When finished, call ${TOOLS.markResult} with success or failure and a concise summary.`,
    ].join("\n"),
  }));
}

export function registerCli(bb: any, { listBoard, spawnTask, updateTask, markTaskResult, removeTask }: BoardApi) {
  const cli = `bb ${PLUGIN_SLUG}`;
  const commands = [
    { name: "list", summary: "List Kanban cards", usage: `${cli} list [--json]` },
    { name: "add", summary: "Spawn a Kanban task thread", usage: `${cli} add <short-name> -- <prompt> [--json]` },
    { name: "move", summary: "Move a card", usage: `${cli} move <thread-id> <column> [note] [--json]` },
    { name: "success", summary: "Mark a card done", usage: `${cli} success <thread-id> <summary> [--json]` },
    { name: "fail", summary: "Mark a card blocked", usage: `${cli} fail <thread-id> <summary> [--json]` },
    { name: "children", summary: "Show or hide a parent's child cards", usage: `${cli} children <parent-thread-id> <show|hide> [--json]` },
    { name: "remove", summary: "Archive/remove a card from the board", usage: `${cli} remove <thread-id> [--json]` },
  ];
  const usage = [
    "Usage:",
    ...commands.map((command) => `  ${command.usage.replace("<column>", `<${COLUMN_IDS.join("|")}>`)}`),
  ].join("\n");
  bb.cli.register({
    name: PLUGIN_SLUG,
    summary: "Manage the Kanban board of BB thread cards",
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
              `${task.threadId}\t${task.column}\t${task.titleChain}${task.statusReason ? ` (${task.statusReason})` : ""}${task.note ? ` — ${task.note}` : ""}`,
          );
          return reply(board, lines.length ? lines.join("\n") : "No Kanban cards yet.");
        }
        if (command === "add") {
          const separator = args.indexOf("--");
          if (separator <= 1) return usageError;
          const shortName = args.slice(1, separator).join(" ");
          const prompt = args.slice(separator + 1).join(" ");
          if (!prompt.trim()) return usageError;
          const task = await spawnTask({ shortName, prompt });
          return reply(task, `Spawned ${task.titleChain} as ${task.threadId}`);
        }
        if (command === "move") {
          const [, threadId, column, ...note] = args;
          if (!threadId || !(COLUMN_IDS as readonly string[]).includes(column)) return usageError;
          const task = await updateTask({ threadId, column: column as Column, note: note.join(" ") || undefined });
          return reply(task, `Moved ${task.titleChain} to ${task.column}`);
        }
        if (command === "success" || command === "fail") {
          const [, threadId, ...rest] = args;
          const summary = rest.join(" ").trim();
          if (!threadId || !summary) return usageError;
          const { task, result } = await markTaskResult(threadId, command === "success", summary);
          return reply(task, `Marked ${task.titleChain} ${result}`);
        }
        if (command === "children") {
          const [, threadId, mode] = args;
          if (!threadId || (mode !== "show" && mode !== "hide")) return usageError;
          const task = await updateTask({ threadId, showChildren: mode === "show" });
          return reply(task, `${mode === "show" ? "Showing" : "Hiding"} child cards for ${task.titleChain}`);
        }
        if (command === "remove") {
          const [, threadId] = args;
          if (!threadId) return usageError;
          return reply({ removed: await removeTask(threadId, { archiveThread: true }) }, `Archived ${threadId} from the board`);
        }
        return command === undefined || command === "help" || command === "--help" ? { exitCode: 0, stdout: usage } : usageError;
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
