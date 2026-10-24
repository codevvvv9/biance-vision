import { api } from "../../../api";
export interface TemplateDto {
  id: string;
  name: string;
  scene: string;
  status: "draft" | "published" | "retired";
  version: number;
  content: string;
  note: string;
  publishedAt: number | null;
  createdAt: number;
}
export interface DisclaimerConfig {
  common: string;
  perp: string;
  event: string;
}
export const loadTemplates = () =>
  api<{
    templates: TemplateDto[];
    pointers: { name: string; scene: string; publishedId: string }[];
  }>("/admin/prompts");
export const loadDisclaimers = () =>
  api<{ disclaimers: DisclaimerConfig }>("/admin/settings/disclaimers");
export const loadInputConfig = () =>
  api<{ chatInput: unknown }>("/admin/settings/chat-input");
export const saveTemplate = (
  id: string | undefined,
  template: { name: string; scene: string; content: string; note: string },
) =>
  api(`/admin/prompts${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: id ? { content: template.content } : template,
  });
export const templateAction = (id: string, action: "publish" | "rollback") =>
  api(`/admin/prompts/${encodeURIComponent(id)}/${action}`, { method: "POST" });
export const saveDisclaimers = (disclaimers: DisclaimerConfig) =>
  api("/admin/settings/disclaimers", { method: "PUT", body: disclaimers });
export const saveInputConfig = (input: unknown) =>
  api("/admin/settings/chat-input", { method: "PUT", body: input });
