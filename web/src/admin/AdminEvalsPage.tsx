import { Drawer, overlayContainer } from "./ui/overlays";
import { useCallback, useState } from "react";
import { App, Alert, Button, Card, Space, Table, Tag, Typography } from "antd";
import type { EvalDataset, EvalRun } from "biance-vision-brooks";
import {
  loadDatasets,
  loadModels,
  loadReport,
  loadRuns,
  runEvaluation,
  type ModelRow,
} from "./features/evals/api";
import { CreateDataset } from "./features/evals/CreateDataset";
import { TrainModel } from "./features/evals/TrainModel";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { Feedback } from "./ui/feedback";
import { AdminViews } from "./ui/views";
import styles from "./ui/admin.module.css";
function Metrics({
  value,
}: {
  value: Record<string, unknown> | null;
}): JSX.Element {
  return (
    <span className={styles.mono}>
      {value
        ? Object.entries(value)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" · ")
        : "—"}
    </span>
  );
}
function Report({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(() => loadReport(id), [id]);
  const resource = useResource(load);
  return (
    <Drawer
      open
      title={text("report")}
      size={800}
      onClose={onClose}
      loading={resource.loading}
    >
      <Feedback error={resource.error} />
      <pre className={styles.pre}>
        {JSON.stringify(resource.data?.report ?? null, null, 2)}
      </pre>
    </Drawer>
  );
}
function Runs(): JSX.Element {
  const text = useAdminText();
  const resource = useResource(loadRuns, 8000);
  const [report, setReport] = useState<string | null>(null);
  return (
    <Card>
      <Feedback error={resource.error} />
      <Table<EvalRun>
        rowKey="id"
        loading={resource.loading && !resource.data}
        dataSource={resource.data?.runs ?? []}
        scroll={{ x: 900 }}
        columns={[
          {
            title: text("runs"),
            dataIndex: "id",
            render: (id) => (
              <Typography.Text copyable>{id.slice(0, 8)}</Typography.Text>
            ),
          },
          { title: text("configuration"), dataIndex: "configVersion" },
          {
            title: text("status"),
            dataIndex: "status",
            render: (status) => <Tag>{text(`eval_${status}`)}</Tag>,
          },
          {
            title: text("metrics"),
            dataIndex: "metrics",
            render: (value) => <Metrics value={value} />,
          },
          {
            title: text("actions"),
            render: (_, run) => (
              <Button size="small" onClick={() => setReport(run.id)}>
                {text("report")}
              </Button>
            ),
          },
        ]}
      />
      {report && (
        <Report key={report} id={report} onClose={() => setReport(null)} />
      )}
    </Card>
  );
}
function Datasets(): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadDatasets);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const run = async (dataset: EvalDataset) => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text("runEvaluation")} · ${dataset.name}`,
        content: text("trainImpact"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await runEvaluation(dataset.id);
      setSuccess(text("operationDone"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={error || resource.error} success={success} />
        <div className={styles.toolbar}>
          <Typography.Text>{text("datasets")}</Typography.Text>
          <Button type="primary" onClick={() => setOpen(true)}>
            {text("newDataset")}
          </Button>
        </div>
        <Table<EvalDataset>
          rowKey="id"
          loading={resource.loading || busy}
          dataSource={resource.data?.datasets ?? []}
          scroll={{ x: 600 }}
          columns={[
            { title: text("name"), dataIndex: "name" },
            { title: text("kind"), dataIndex: "kind" },
            {
              title: text("version"),
              dataIndex: "version",
              render: (value) => `v${value}`,
            },
            { title: text("itemCount"), dataIndex: "itemCount" },
            {
              title: text("actions"),
              render: (_, dataset) => (
                <Button size="small" onClick={() => void run(dataset)}>
                  {text("runEvaluation")}
                </Button>
              ),
            },
          ]}
        />
        {open && (
          <CreateDataset
            onClose={() => setOpen(false)}
            onSaved={() => void resource.reload()}
          />
        )}
      </div>
    </Card>
  );
}
function Models(): JSX.Element {
  const text = useAdminText();
  const resource = useResource(loadModels, 8000);
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={resource.error} />
        {resource.data && (
          <Alert
            type={resource.data.researchPy.healthy ? "success" : "error"}
            title={text(
              resource.data.researchPy.healthy
                ? "serviceHealthy"
                : "serviceUnavailable",
            )}
            showIcon
          />
        )}
        <div className={styles.toolbar}>
          <Typography.Text>{text("models")}</Typography.Text>
          <Button
            type="primary"
            onClick={() => setOpen(true)}
            disabled={!resource.data?.researchPy.healthy}
          >
            {text("trainModel")}
          </Button>
        </div>
        <Table<ModelRow>
          rowKey="modelVersion"
          loading={resource.loading && !resource.data}
          dataSource={resource.data?.models ?? []}
          scroll={{ x: 900 }}
          columns={[
            { title: text("model"), dataIndex: "modelVersion" },
            {
              title: text("horizon"),
              dataIndex: "horizon",
              render: (value) => (
                <Space>
                  {value}
                  {value === "1w" && (
                    <Tag color="warning">{text("researchMode")}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => <Tag>{text(`model_${status}`)}</Tag>,
            },
            {
              title: text("trainedUntil"),
              dataIndex: "trainedUntil",
              render: (value) =>
                value ? new Date(value).toLocaleString() : "—",
            },
            {
              title: text("metrics"),
              dataIndex: "metrics",
              render: (value) => <Metrics value={value} />,
            },
          ]}
        />
        {open && (
          <TrainModel
            onClose={() => setOpen(false)}
            onSaved={() => void resource.reload()}
          />
        )}
      </div>
    </Card>
  );
}
export default function AdminEvalsPage(): JSX.Element {
  return (
    <AdminViews
      items={[
        { key: "runs", label: "runs", children: <Runs /> },
        { key: "datasets", label: "datasets", children: <Datasets /> },
        { key: "models", label: "models", children: <Models /> },
      ]}
    />
  );
}
