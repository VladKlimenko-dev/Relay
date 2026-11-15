// Understanding GitHub intentions in a request (English and Russian), deterministically.
// The planner model may also propose actions; every action is shown in the plan and runs only after approval.
import { z } from "zod";

export type Workflow = "pull_request" | "direct";
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("close_pr"), number: z.number().int().positive(), deleteBranch: z.boolean().default(false) }),
  z.object({ type: z.literal("reopen_pr"), number: z.number().int().positive() }),
  z.object({ type: z.literal("merge_pr"), number: z.number().int().positive(), method: z.enum(["merge", "squash", "rebase"]).default("merge") }),
  z.object({ type: z.literal("delete_branch"), branch: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/) }),
]);
export type GitAction = z.infer<typeof gitActionSchema> & { status?: "queued" | "complete" | "failed"; result?: string };

const PR = String.raw`(?:pull[\s-]?requests?|PRs?|ПР|пул+[\s-]?реквест[\p{L}\p{N}_]*|запрос[\p{L}\p{N}_]*\s+на\s+(?:слияние|изменени[\p{L}\p{N}_]*))`;
const NUMS = String.raw`(?:#|№|number\s*|номер\s*)?(\d+(?:\s*(?:,|and|и|&)\s*(?:#|№)?\d+)*)`;
const numbers = (s: string) => (s.match(/\d+/g) || []).map(Number);

export function detectWorkflow(text: string): Workflow | null {
  const t = text.toLowerCase();
  const direct = [
    new RegExp(String.raw`\b(?:no|without|skip)\s+(?:a\s+|an\s+|any\s+)?(?:new\s+|additional\s+|extra\s+|separate\s+)?${PR}`, "iu"),
    new RegExp(String.raw`\b(?:do\s*n[o']?t|never)\s+(?:create|open|make|use|raise)\s+(?:a\s+|an\s+|any\s+)?(?:new\s+|additional\s+|extra\s+|separate\s+)?${PR}`, "iu"),
    /\b(?:commit|push|work)[\p{L}\p{N}_]*\s+(?:directly|straight)\b/iu,
    /\b(?:directly|straight)\s+(?:to|into|on|in)\s+(?:the\s+)?(?:repo|repository|main|master|default\s+branch|branch)/i,
    /\bwork\s+(?:on|in)\s+the\s+(?:repo|repository)\s+itself/i,
    new RegExp(String.raw`без\s+(?:нов[\p{L}\p{N}_]*\s+|дополнительн[\p{L}\p{N}_]*\s+|отдельн[\p{L}\p{N}_]*\s+|лишн[\p{L}\p{N}_]*\s+)?${PR}`, "iu"),
    new RegExp(String.raw`не\s+(?:создавай|открывай|делай|нужн[\p{L}\p{N}_]*|надо)\s+(?:нов[\p{L}\p{N}_]*\s+|дополнительн[\p{L}\p{N}_]*\s+|отдельн[\p{L}\p{N}_]*\s+|лишн[\p{L}\p{N}_]*\s+)?${PR}`, "iu"),
    /напрямую|прямо\s+в\s+(?:репозитори|ветк|main|master)|в\s+сам[\p{L}\p{N}_]*\s+репозитори/iu,
  ];
  if (direct.some(r => r.test(t))) return "direct";
  const pr = [new RegExp(String.raw`\b(?:open|create|make|raise|submit)\s+(?:a\s+|an\s+)?(?:new\s+)?${PR}`, "iu"), new RegExp(String.raw`(?:создай|открой|сделай|оформи)\s+(?:нов[\p{L}\p{N}_]*\s+)?${PR}`, "iu")];
  if (pr.some(r => r.test(t))) return "pull_request";
  return null;
}

export function detectGitActions(text: string): GitAction[] {
  const out: GitAction[] = [];
  const t = text;
  const add = (a: GitAction) => { if (!out.some(o => JSON.stringify({ ...o, status: undefined }) === JSON.stringify({ ...a, status: undefined }))) out.push(a); };
  const wantsBranchGone = /(?:delete|remove|drop)\s+(?:the\s+|its\s+|their\s+)?(?:head\s+)?branch|удали[\p{L}\p{N}_]*\s+(?:и\s+)?(?:е[её]\s+|их\s+)?ветк/iu.test(t);
  // close / delete PR (GitHub has no PR deletion: delete = close + delete head branch)
  for (const re of [new RegExp(String.raw`(close|delete|remove|drop|cancel|discard|закр[\p{L}\p{N}_]*|удал[\p{L}\p{N}_]*|отмен[\p{L}\p{N}_]*)\s+(?:the\s+|this\s+|этот\s+|эти\s+)?${PR}\s*${NUMS}`, "giu"),
                    new RegExp(String.raw`${PR}\s*${NUMS}\s*[,:-]?\s*(close|delete|remove|закр[\p{L}\p{N}_]*|удал[\p{L}\p{N}_]*)`, "giu")]) {
    for (const m of t.matchAll(re)) {
      const verb = (/\d/.test(m[1]) ? m[2] : m[1]).toLowerCase(), nums = numbers(/\d/.test(m[1]) ? m[1] : m[2]);
      const isDelete = /^(delete|remove|drop|discard|удал)/.test(verb);
      for (const n of nums) add({ type: "close_pr", number: n, deleteBranch: isDelete || wantsBranchGone });
    }
  }
  for (const m of t.matchAll(new RegExp(String.raw`(reopen|re-open|переоткр[\p{L}\p{N}_]*|открой\s+снова|верни)\s+(?:the\s+)?${PR}\s*${NUMS}`, "giu")))
    for (const n of numbers(m[2])) add({ type: "reopen_pr", number: n });
  for (const m of t.matchAll(new RegExp(String.raw`(merge|squash|rebase|слей|смерж[\p{L}\p{N}_]*|влей|объедин[\p{L}\p{N}_]*)\s+(?:the\s+)?${PR}\s*${NUMS}`, "giu"))) {
    const method = /squash|сквош/i.test(t) ? "squash" : /^rebase/i.test(m[1]) || /\brebase\b|ребейз/i.test(t) ? "rebase" : "merge";
    for (const n of numbers(m[2])) add({ type: "merge_pr", number: n, method });
  }
  for (const m of t.matchAll(/(?:delete|remove|удали[\p{L}\p{N}_]*)\s+(?:the\s+|remote\s+)?(?:branch|ветку)\s+[`"']?([A-Za-z0-9._\/-]+)[`"']?/giu))
    if (!/^(?:of|for|from|после|у)$/i.test(m[1])) add({ type: "delete_branch", branch: m[1] });
  return out.map(a => ({ ...a, status: "queued" as const }));
}

export const mentionsGitHub = (text: string) => new RegExp(String.raw`${PR}|branch|ветк|merge|слей|смерж|commit|коммит|push|пуш`, "iu").test(text);

export function describeAction(a: GitAction) {
  switch (a.type) {
    case "close_pr": return `Close pull request #${a.number}${a.deleteBranch ? " and delete its branch (GitHub cannot delete pull requests; closing it and deleting its branch is the equivalent)" : ""}`;
    case "reopen_pr": return `Reopen pull request #${a.number}`;
    case "merge_pr": return `Merge pull request #${a.number} (${a.method})`;
    case "delete_branch": return `Delete branch ${a.branch} on GitHub`;
  }
}
