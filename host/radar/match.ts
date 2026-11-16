// LLM pairing of kept ideas with ExP problem cards.
import { feedbackPrompt } from "./feedback";
import { inBatches, structured } from "./llm";
import type { Classification } from "./classify";
import type { Problem } from "./registry";

export interface Match {
  ts: string;
  problemId: string;
  strength: number;
  why: string;
  tryThis: string;
}

const SYSTEM = `You pair new AI tech, findings and leadership initiatives from #ai-centaurs with problems owned by ExP
(Shopify's Experiments Platform team). The reader is an ExP engineer hunting for creative, concrete ways to apply what
other teams are discovering. For each idea pick the single best problem from the registry, or "none".

An idea can transfer as a product (use this tool/model), a technique (copy this workflow, prompt pattern, eval method
or automation), or a finding (evidence that changes how ExP should attack the problem). Look past surface topic: a
cheaper frontier model matters to a problem whose pain includes agent cost; a team's planning automation matters to a
large in-flight migration; a durable-agent runtime matters to long-running agent workflows.

strength = how confidently an ExP engineer could start a useful experiment on that problem this week:
- 0.9-1.0: directly hits the problem's stated pain or "what would help"; ready to try; clear payoff.
- 0.7-0.8: credible transfer with a concrete first step; payoff plausible but unproven.
- 0.5-0.6: the connection needs a leap, or the first step is vague.
- < 0.5: no real connection. Use problemId "none" with strength 0.
Never inflate: "AI could help with this" is not a connection. Personal productivity tools and generic model launches
only count when they change something specific about a listed problem.

why: <= 35 words linking the specific capability/finding to the specific pain.
tryThis: <= 30 words, one concrete first step (what to try, on which ExP system/workflow), no fluff.
Only use problem ids from the registry. Return exactly one item per idea, echoing its ts.`;

const SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["ts", "problemId", "strength", "why", "tryThis"],
        properties: {
          ts: { type: "string" },
          problemId: { type: "string" },
          strength: { type: "number" },
          why: { type: "string" },
          tryThis: { type: "string" },
        },
      },
    },
  },
};

const BATCH_SIZE = 20;

export async function match(ideas: Classification[], problems: Problem[]): Promise<Match[]> {
  const registry = problems
    .map((p) => `- ${p.id} [${p.kind}] ${p.title}: ${p.summary} What would help: ${p.whatWouldHelp}`)
    .join("\n");
  const system = `${SYSTEM}\n\nProblem registry:\n${registry}${feedbackPrompt()}`;
  const ids = new Set(problems.map((p) => p.id));
  return inBatches(ideas, BATCH_SIZE, async (batch) => {
    const res = await structured<{ items: Match[] }>({
      system,
      user: batch
        .map((c) => `<idea ts="${c.ts}" category="${c.category}">\n${c.title}\n${c.summary}\nNew: ${c.whatIsNew}\n</idea>`)
        .join("\n\n"),
      schema: SCHEMA,
    });
    const wanted = new Set(batch.map((idea) => idea.ts));
    const received = new Set(res.items.map((item) => item.ts));
    if (res.items.length !== wanted.size || received.size !== wanted.size || [...wanted].some((ts) => !received.has(ts))) {
      throw new Error("Matching omitted or duplicated ideas; discovery checkpoint was not advanced");
    }
    return res.items.map((m) => (ids.has(m.problemId) ? m : { ...m, problemId: "none", strength: 0 }));
  });
}
