import { api } from "../../../api";
import type { SearchDebugResult } from "biance-vision-brooks";
export interface RuleCard {
  id: string;
  concept: string;
  status: string;
  version: number;
  draftedBy: string;
  content: {
    definition?: string;
    conditions?: string[];
    context?: string;
    invalidation?: string;
    confusable?: string[];
    counterExamples?: string[];
    ruleId?: string;
    sourceNote?: string;
  };
}
export interface CaseWindow {
  id: string;
  symbol: string;
  interval: string;
  atTime: number;
  published: boolean;
  annotation: string;
  visibleContext: { regime?: string; alwaysIn?: string };
}
export const loadCards = () =>
  api<{ cards: RuleCard[] }>("/admin/knowledge/rule-cards");
export const draftCard = (concept: string) =>
  api<{ card: RuleCard }>("/admin/knowledge/rule-cards/draft", {
    method: "POST",
    body: { concept },
  });
export const saveCard = (id: string, content: RuleCard["content"]) =>
  api(`/admin/knowledge/rule-cards/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { content },
  });
export const cardAction = (id: string, action: "publish" | "delete") =>
  api(
    `/admin/knowledge/rule-cards/${encodeURIComponent(id)}${action === "publish" ? "/publish" : ""}`,
    { method: action === "delete" ? "DELETE" : "POST" },
  );
export const loadCases = () =>
  api<{ cases: CaseWindow[] }>("/admin/knowledge/cases?all=1");
export const buildCase = (input: {
  symbol: string;
  interval: string;
  annotation: string;
}) =>
  api("/admin/knowledge/cases", {
    method: "POST",
    body: { ...input, marketType: "usdm_perp" },
  });
export const publishCase = (id: string) =>
  api(`/admin/knowledge/cases/${encodeURIComponent(id)}/publish`, {
    method: "POST",
  });
export const searchKnowledge = (query: string, mode: "support" | "counter") =>
  api<SearchDebugResult>(
    `/admin/knowledge/search-debug?query=${encodeURIComponent(query)}&mode=${mode}`,
  );
