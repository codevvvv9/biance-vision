import { api } from "../../../api";
import type { KnowledgeDocument } from "biance-vision-brooks";
const root = "/admin/knowledge";
export const loadDocuments = () =>
  api<{ documents: KnowledgeDocument[] }>(`${root}/documents`);
export const documentAction = (id: string, action: "publish" | "reparse") =>
  api(`${root}/documents/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    ...(action === "publish" ? { body: {} } : {}),
  });
export const deleteDocument = (id: string, purge = false) =>
  api(`${root}/documents/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`, {
    method: "DELETE",
  });
export interface BatchResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}
export const batchDocuments = (
  action: "publish" | "reparse" | "delete",
  ids: string[],
) =>
  api<BatchResult>(`${root}/documents/batch`, {
    method: "POST",
    body: { action, ids },
  });
