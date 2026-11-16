import { z } from "zod";

const sourceUrl = z.string().url().refine((value) => /^https:\/\//u.test(value), "Expected an HTTPS source");
export const radarSolutionSchema = z.object({ idea: z.string().min(1), fit: z.number(), buyIn: z.number(), ambition: z.number() });
const evidenceSchema = z.object({ ref: z.string(), quote: z.string(), url: sourceUrl });
export const radarOpportunitySchema = z.object({
  key: z.string().min(1), title: z.string(), problem: z.string(), owner: z.enum(["unowned", "partly_owned"]),
  ask: z.number(), askWhy: z.string(), solutions: z.array(radarSolutionSchema).min(1), evidence: z.array(evidenceSchema).min(1),
}).passthrough();
const ideaSchema = z.object({
  id: z.string(), ideaKey: z.string().min(1), title: z.string(), summary: z.string(), whatIsNew: z.string(),
  permalink: sourceUrl.refine((url) => { const host = new URL(url).hostname; return host === "slack.com" || host.endsWith(".slack.com"); }, "Expected a Slack source"),
}).passthrough();
export const radarDigestSchema = z.object({
  date: z.string(), generatedAt: z.string(), pairings: z.array(ideaSchema), others: z.array(ideaSchema),
  backlog: z.array(z.unknown()), watch: z.object({ opportunities: z.array(radarOpportunitySchema), error: z.string().optional(), skipped: z.array(z.string()).optional() }).passthrough(),
}).passthrough();
export type RadarDigest = z.infer<typeof radarDigestSchema>;
export const radarItemSchema = z.object({
  id: z.string(), kind: z.enum(["opportunity", "technique"]), title: z.string(), summary: z.string(),
  sourceUrl, read: z.boolean(), threadId: z.string().nullable(), createdAt: z.string(),
});
export type RadarItem = z.infer<typeof radarItemSchema>;
export const radarStateSchema = z.object({
  items: z.array(radarItemSchema), unread: z.number().int(), generatedAt: z.string().nullable(), running: z.boolean(), error: z.string().nullable(),
});
export type RadarState = z.infer<typeof radarStateSchema>;
export const radarActionSchema = z.object({
  action: z.enum(["scan", "refresh", "backfill", "feedback"]),
  days: z.number().int().min(1).max(365).optional(), id: z.string().max(300).optional(), vote: z.enum(["up", "down"]).optional(),
  note: z.string().max(4000).optional(),
}).strict();
export type RadarAction = z.infer<typeof radarActionSchema>;

export const radarRankItemSchema = z.object({
  id: z.string(), kind: z.enum(["opportunity", "technique"]), read: z.boolean(),
  threadId: z.string().nullable(), createdAt: z.string(),
  finding: z.union([radarOpportunitySchema, ideaSchema]),
}).strict();
export const radarRankingSchema = z.object({
  order: z.array(z.string()), rationale: z.string(),
  rounds: z.array(z.object({ ranking: z.array(z.string()), review: z.string() }).strict()).length(3),
}).strict();
