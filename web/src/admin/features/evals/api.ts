import { api } from "../../../api";
import type {
  EvalDataset,
  EvalRun,
  PredictionModelInfo,
} from "biance-vision-brooks";
export interface ModelRow extends PredictionModelInfo {
  artifactPath: string | null;
}
export const loadDatasets = () =>
  api<{ datasets: EvalDataset[] }>("/admin/evaluations/datasets");
export const loadRuns = () =>
  api<{ runs: EvalRun[] }>("/admin/evaluations/runs");
export const loadModels = () =>
  api<{ models: ModelRow[]; researchPy: { healthy: boolean } }>(
    "/admin/models",
  );
export const createDataset = (kind: string, name: string, items: unknown) =>
  api("/admin/evaluations/datasets", {
    method: "POST",
    body: { kind, name, items },
  });
export const runEvaluation = (datasetId: string) =>
  api("/admin/evaluations/runs", { method: "POST", body: { datasetId } });
export const loadReport = (id: string) =>
  api<{ report: Record<string, unknown> | null }>(
    `/admin/evaluations/runs/${encodeURIComponent(id)}`,
  );
export const trainModel = (modelVersion: string, horizon: string) =>
  api("/admin/models/train", {
    method: "POST",
    body: { modelVersion, horizon },
  });
