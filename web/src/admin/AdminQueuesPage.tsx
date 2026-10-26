import { useState } from "react";
import { App, Button, Card, Table, Tag, Tooltip, Typography } from "antd";
import {
  loadQueueHealth,
  purgeQueue,
  type QueueHealthRow,
} from "./features/queues/api";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { Feedback } from "./ui/feedback";
import { overlayContainer } from "./ui/overlays";
import styles from "./ui/admin.module.css";

/** 滞留时长展示（单位符号语言中性，免词典）：92s / 37m / 2h13m / 3d5h */
function fmtAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export default function AdminQueuesPage(): JSX.Element {
  const text = useAdminText(),
    resource = useResource(loadQueueHealth, 30_000),
    { modal } = App.useApp();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");

  const purge = async (row: QueueHealthRow) => {
    if (busy) return;
    if (
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: text("purgeConfirmTitle"),
        content: text("purgeConfirmBody", { queue: row.name, created: row.created }),
        okText: text("purgeBacklog"),
        cancelText: text("cancel"),
        okButtonProps: { danger: true },
      }))
    )
      return;
    setBusy(row.name);
    setError("");
    setSuccess("");
    try {
      const r = await purgeQueue(row.name);
      setSuccess(text("purgeDone", { queue: r.queue, count: r.purged }));
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const columns = [
    { title: text("colQueue"), dataIndex: "name", key: "name", render: (v: string) => <span className={styles.mono}>{v}</span> },
    { title: text("colCreated"), dataIndex: "created", key: "created", render: (v: number, r: QueueHealthRow) => (v > 1000 ? <Tag color="error">{v}</Tag> : v > 200 ? <Tag color="warning">{v}</Tag> : <span>{v}</span>) },
    { title: text("colActive"), dataIndex: "active", key: "active" },
    { title: text("colRetry"), dataIndex: "retry", key: "retry" },
    { title: text("colCompleted"), dataIndex: "completed", key: "completed" },
    { title: text("colFailed"), dataIndex: "failed", key: "failed", render: (v: number) => (v > 0 ? <Tag color="error">{v}</Tag> : v) },
    { title: text("colOldest"), dataIndex: "oldestCreatedAgeSeconds", key: "oldest", render: (v: number | null) => <span className={styles.mono}>{fmtAge(v)}</span> },
    {
      title: text("colRetention"),
      dataIndex: "retentionMinutes",
      key: "retention",
      render: (v: number | null) =>
        v === null ? <Tooltip title={text("preciousHint")}><Tag>{text("preciousTag")}</Tag></Tooltip> : <span className={styles.mono}>{v}m</span>,
    },
    {
      title: text("colAction"),
      key: "action",
      render: (_: unknown, row: QueueHealthRow) =>
        row.purgeable ? (
          <Button size="small" danger disabled={busy !== "" || row.created === 0} onClick={() => void purge(row)}>
            {text("purgeBacklog")}
          </Button>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div className={styles.stack}>
      <Feedback error={error || resource.error} success={success} />
      <Card
        extra={<Button onClick={() => void resource.reload()}>{text("refresh")}</Button>}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {text("queueHint")}
        </Typography.Paragraph>
        <Table<QueueHealthRow>
          rowKey="name"
          size="small"
          loading={resource.loading}
          dataSource={resource.data?.queues ?? []}
          columns={columns}
          pagination={false}
        />
      </Card>
    </div>
  );
}
