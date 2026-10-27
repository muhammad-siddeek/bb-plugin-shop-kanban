import { z } from "zod";

export const COLUMN_IDS = ["queue", "wip", "blocked", "done"] as const;
export type Column = (typeof COLUMN_IDS)[number];
export type Result = "success" | "failed";

export const columnSchema = z.enum(COLUMN_IDS);
export const resultSchema = z.enum(["success", "failed"]);

export const COLUMNS: Record<Column, { id: Column; title: string; description: string }> = {
  queue: { id: "queue", title: "Queue", description: "Tasks waiting to be started." },
  wip: { id: "wip", title: "WIP", description: "Tasks currently running, or with running children." },
  blocked: { id: "blocked", title: "Blocked", description: "Idle tasks that need user input or asked a question." },
  done: { id: "done", title: "Done", description: "Idle tasks whose last message reported completion." },
};

export const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  status: z.string().nullable(),
  runtimeStatus: z.string().nullable(),
  providerId: z.string().nullable(),
  updatedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
});

export const boardTaskSchema = z.object({
  threadId: z.string(),
  shortName: z.string(),
  titleChain: z.string(),
  column: columnSchema,
  parentThreadId: z.string().nullable(),
  projectId: z.string().nullable(),
  description: z.string().nullable(),
  result: resultSchema.nullable(),
  note: z.string().nullable(),
  showOnBoard: z.boolean(),
  showChildren: z.boolean(),
  childCount: z.number(),
  hiddenChildCount: z.number(),
  runningChildCount: z.number(),
  statusReason: z.string().nullable(),
  /** bb's unread state: new activity since the user last opened the thread. */
  unread: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUserInputAt: z.string().nullable(),
  missingThread: z.boolean(),
  thread: threadSummarySchema.nullable(),
});

export const boardColumnSchema = z.object({ id: columnSchema, title: z.string(), description: z.string() });
export const boardStateSchema = z.object({ columns: z.array(boardColumnSchema), tasks: z.array(boardTaskSchema) });

export const rpcContract = {
  board_list: { input: z.null(), output: boardStateSchema },
  board_spawn_task: {
    input: z.object({
      shortName: z.string().trim().min(1).max(40),
      prompt: z.string().trim().min(1).max(12_000),
      projectId: z.string().optional(),
      parentThreadId: z.string().optional(),
      column: columnSchema.optional(),
      showOnBoard: z.boolean().optional(),
    }),
    output: boardTaskSchema,
  },
  board_update_task: {
    input: z.object({
      threadId: z.string(),
      column: columnSchema.optional(),
      shortName: z.string().trim().min(1).max(40).optional(),
      note: z.string().trim().max(2_000).optional(),
      result: resultSchema.nullable().optional(),
      showOnBoard: z.boolean().optional(),
      showChildren: z.boolean().optional(),
    }),
    output: boardTaskSchema,
  },
  board_remove_task: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  board_mark_read: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
};

export type StoredTask = {
  threadId: string;
  shortName: string;
  titleChain: string;
  column: Column;
  parentThreadId: string | null;
  projectId: string | null;
  description: string | null;
  result: Result | null;
  note: string | null;
  showOnBoard: boolean;
  showChildren: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BoardTask = z.infer<typeof boardTaskSchema>;
