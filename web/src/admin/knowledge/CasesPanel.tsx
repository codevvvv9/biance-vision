import { overlayContainer } from "../ui/overlays";
import { useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  loadCases,
  buildCase,
  publishCase,
  type CaseWindow,
} from "../features/knowledge/contentApi";
import { useResource } from "../ui/resource";
import { useDirtyForm } from "../ui/forms";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
import styles from "../ui/admin.module.css";
export default function CasesPanel({
  onError,
}: {
  onError: (message: string) => void;
}): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadCases);
  const [symbol, setSymbol] = useState("BTCUSDT"),
    [interval, setIntervalValue] = useState("15m"),
    [annotation, setAnnotation] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useDirtyForm(
    Boolean(annotation) || symbol !== "BTCUSDT" || interval !== "15m",
  );
  const build = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await buildCase({ symbol, interval, annotation });
      setAnnotation("");
      setSymbol("BTCUSDT");
      setIntervalValue("15m");
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const publish = async (item: CaseWindow) => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text("publish")} · ${item.symbol}`,
        content: text("caseVisibilityHint"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    try {
      await publishCase(item.id);
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={error || resource.error} />
        <Typography.Paragraph type="secondary">
          {text("caseVisibilityHint")}
        </Typography.Paragraph>
        <Form layout="vertical">
          <div className={styles.grid}>
            <Form.Item label={text("symbol")}>
              <Input
                aria-label={text("symbol")}
                value={symbol}
                onChange={(event) =>
                  setSymbol(event.target.value.toUpperCase())
                }
              />
            </Form.Item>
            <Form.Item label={text("interval")}>
              <Select
                aria-label={text("interval")}
                value={interval}
                onChange={setIntervalValue}
                options={["5m", "15m", "1h", "4h"].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </Form.Item>
            <Form.Item label={text("annotation")}>
              <Input
                aria-label={text("annotation")}
                value={annotation}
                onChange={(event) => setAnnotation(event.target.value)}
              />
            </Form.Item>
          </div>
          <Button
            type="primary"
            loading={busy}
            disabled={!symbol}
            onClick={() => void build()}
          >
            {text("buildCase")}
          </Button>
        </Form>
        <Table<CaseWindow>
          rowKey="id"
          loading={resource.loading || busy}
          dataSource={resource.data?.cases ?? []}
          scroll={{ x: 700 }}
          columns={[
            {
              title: text("symbol"),
              render: (_, item) => `${item.symbol} ${item.interval}`,
            },
            {
              title: text("decisionTime"),
              dataIndex: "atTime",
              render: (value) => new Date(value).toLocaleString(),
            },
            {
              title: text("status"),
              dataIndex: "published",
              render: (value) => (
                <Tag color={value ? "success" : undefined}>
                  {text(value ? "published" : "draft")}
                </Tag>
              ),
            },
            {
              title: text("structure"),
              render: (_, item) => (
                <Space>
                  {item.visibleContext.regime ?? "—"}{" "}
                  {item.visibleContext.alwaysIn ?? ""}
                </Space>
              ),
            },
            {
              title: text("actions"),
              render: (_, item) =>
                !item.published && (
                  <Button size="small" onClick={() => void publish(item)}>
                    {text("publish")}
                  </Button>
                ),
            },
          ]}
        />
      </div>
    </Card>
  );
}
