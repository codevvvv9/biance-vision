import { api } from "../../../api";
import type { AgentCapabilities, AgentVersion } from "biance-vision-brooks";
export const loadAgentVersions = () =>
  api<{ versions: AgentVersion[]; currentVersionId: string | null }>(
    "/admin/agents/versions",
  );
export const loadAgentCapabilities = () =>
  api<{ capabilities: AgentCapabilities; source: string }>(
    "/admin/agents/capabilities",
  );
export const saveCapabilities = (capabilities: AgentCapabilities) =>
  api("/admin/agents/capabilities", { method: "PUT", body: capabilities });
export interface CapabilityTest {
  results: Record<
    string,
    { status: string; detail: string; latencyMs?: number }
  >;
  totalMs: number;
}
export const testCapabilities = (capabilities: AgentCapabilities) =>
  api<CapabilityTest>("/admin/agents/capabilities/test", {
    method: "POST",
    body: { capabilities },
  });
export const saveAgentDraft = (
  id: string | undefined,
  label: string,
  config: unknown,
) =>
  api(`/admin/agents/versions${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: id ? { config } : { label, config },
  });
export const agentVersionAction = (
  id: string,
  action: "publish" | "rollback",
) =>
  api(`/admin/agents/versions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
  });
export interface DebugRun {
  versionLabel: string;
  checks: Record<string, string>;
  retrievalSmoke: { hits: number; topTitles: string[]; notes: string[] };
}
export const debugAgent = (id: string) =>
  api<DebugRun>(`/admin/agents/versions/${encodeURIComponent(id)}/debug-run`, {
    method: "POST",
  });
