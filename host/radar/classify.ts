// LLM triage of channel messages into keep (new tech / finding / leadership push) vs noise.
import { CONFIG } from "./config";
import { feedbackPrompt } from "./feedback";
import type { Priority } from "./leaders";
import { inBatches, structured } from "./llm";
import type { Message, Reply } from "./slack";

export const CATEGORIES = [
  "new_tech",
  "new_finding",
  "leadership_push",
  "meme_joke",
  "personal_anecdote",
  "complaint_or_support",
  "question",
  "social",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  ts: string;
  category: Category;
  confidence: number;
  ideaKey: string;
  title: string;
  summary: string;
  whatIsNew: string;
  confirmations: number;
  links: string[];
  priorityIds: string[];
}

export interface ClassifyInput {
  msg: Message;
  replies: Reply[];
  authorTitle: string;
}

const SYSTEM = `You triage messages from #ai-centaurs, a busy Shopify Slack channel about AI models, agents and tools.
The reader is a senior engineer on ExP (Experiments Platform). They only want three kinds of message:

KEEP
- new_tech: a new or newly available tool, model, platform capability, internal service, skill, harness feature,
  or agent technique that people can use now. Launches, releases, internal tools (Quick sites, River/Muse features,
  skills, CLIs) and open-source projects count.
- new_finding: a result with evidence: benchmark or comparison, experiment outcome, measured workflow change
  ("throughput up 500%"), a write-up of what worked or failed and why, a reproducible lesson.
- leadership_push: a direction, initiative, mandate or program that Shopify leadership is driving: posted by or
  quoting leaders, linking leadership memos/posts, announcing company programs, or clearly serving one of the
  leadership priorities listed below.

DROP (classify precisely)
- meme_joke: humor, reaction images, banter, hot takes or vibes without substance.
- personal_anecdote: a personal story or opinion without a transferable, evidenced finding.
- complaint_or_support: billing, quota, access, outages, bugs, "where do I report this".
- question: asking for help or recommendations. Exception: if the thread contains a strong answer that is itself
  new tech or a finding, classify by that answer and summarize the answer instead.
- social: farewells, welcomes, kudos, celebrations without content.
- other: anything else.

Rules
- Judge substance, never popularity. A hugely popular joke is still meme_joke.
- A bare link counts only if the text, attachment preview or thread makes clear what is new.
- confidence: 0..1 that the category is right. Use < 0.6 when unsure.
- ideaKey: stable kebab-case slug for the underlying idea, not the message. Every message about the same
  launch/tool/finding must share it (e.g. "gpt-6-1-sol-launch", "unravel-river-thread-tracker").
- title: <= 12 words naming the tech/finding/initiative. summary: <= 40 words, concrete.
- whatIsNew: <= 25 words on what is new or measured. Empty for dropped categories.
- confirmations: number of thread replies where someone reports trying/adopting it with a positive result,
  or independently corroborates the finding.
- links: the most relevant URLs from the message/attachments/thread (max 3), copied verbatim.
- priorityIds: ids of the leadership priorities this clearly serves (empty if none or dropped).
Return exactly one item per input message, echoing its ts.`;

const SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["ts", "category", "confidence", "ideaKey", "title", "summary", "whatIsNew", "confirmations", "links", "priorityIds"],
        properties: {
          ts: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          confidence: { type: "number" },
          ideaKey: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          whatIsNew: { type: "string" },
          confirmations: { type: "integer" },
          links: { type: "array", items: { type: "string" } },
          priorityIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function render({ msg, replies, authorTitle }: ClassifyInput): string {
  const reactions = msg.reactions.map((r) => `${r.name}x${r.count}`).join(", ");
  const parts = [
    `<message ts="${msg.ts}" author="${msg.userName}${authorTitle ? ` (${authorTitle})` : ""}" replies="${msg.replyCount}" reactions="${reactions}">`,
    msg.text,
  ];
  if (msg.attachments.length) parts.push(`attachments:\n${msg.attachments.map((a) => `- ${a}`).join("\n")}`);
  if (msg.files.length) parts.push(`files: ${msg.files.join(", ")}`);
  if (replies.length) parts.push(`<thread>\n${replies.map((r) => `- ${r.userName}: ${r.text}`).join("\n")}\n</thread>`);
  parts.push("</message>");
  return parts.join("\n");
}

export interface KnownIdea {
  key: string;
  title: string;
}

export async function classify(inputs: ClassifyInput[], priorities: Priority[], known: KnownIdea[]): Promise<Classification[]> {
  let system =
    SYSTEM + `\n\nLeadership priorities:\n${priorities.map((p) => `- ${p.id}: ${p.theme}. ${p.description}`).join("\n")}`;
  if (known.length) {
    system += `\n\nIdea keys already reported (reuse the key when a message is about the same idea):\n${known
      .map((k) => `- ${k.key}: ${k.title}`)
      .join("\n")}`;
  }
  system += feedbackPrompt();
  return inBatches(inputs, CONFIG.classifyBatchSize, async (batch) => {
    const res = await structured<{ items: Classification[] }>({
      system,
      user: batch.map(render).join("\n\n"),
      schema: SCHEMA,
    });
    const wanted = new Set(batch.map((b) => b.msg.ts));
    return res.items.filter((it) => wanted.has(it.ts));
  });
}
