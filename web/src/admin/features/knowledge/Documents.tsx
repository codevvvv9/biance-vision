import { overlayContainer } from "../../ui/overlays";
import { useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Dropdown,
  Typography,
} from "antd";
import type { KnowledgeDocument } from "biance-vision-brooks";
import { useAdminText } from "../../ui/text";
import type { BatchResult } from "./api";
import styles from "../../ui/admin.module.css";
const states = [
  "uploaded",
  "parsing",
  "parsed",
  "chunked",
  "indexed",
  "published",
  "failed",
] as const;
const colors: Record<string, string> = {
  parsing: "processing",
  indexed: "warning",
  published: "success",
  failed: "error",
};
export function DocumentStatus({ status }: { status: string }): JSX.Element {
  const text = useAdminText();
  return <Tag color={colors[status]}>{text(`doc_${status}`)}</Tag>;
}
interface Props {
  docs: KnowledgeDocument[];
  loading: boolean;
  onPreview: (id: string) => void;
  onLogs: (id: string) => void;
  onVersions: () => void;
  onAction: (id: string, action: "publish" | "reparse") => Promise<void>;
  onDelete: (id: string, purge?: boolean) => Promise<void>;
  onBatch: (
    action: "publish" | "reparse" | "delete",
    ids: string[],
  ) => Promise<BatchResult | undefined>;
}
export function Documents({
  docs,
  loading,
  onPreview,
  onLogs,
  onVersions,
  onAction,
  onDelete,
  onBatch,
}: Props): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const existing = new Set(docs.map((doc) => doc.id));
    setSelected((previous) =>
      previous.filter((id) => existing.has(String(id))),
    );
  }, [docs]);
  const counts = useMemo(
    () =>
      new Map(
        states.map((state) => [
          state,
          docs.filter((doc) => doc.status === state).length,
        ]),
      ),
    [docs],
  );
  const filtered = docs.filter(
    (doc) =>
      (!status || doc.status === status) &&
      doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (title: string, operation: () => Promise<unknown>) => {
    if (
      await modal.confirm({
        getContainer: overlayContainer,
        title,
        content: text("operationImpact"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      })
    )
      await act(operation);
  };
  const batch = (action: "publish" | "reparse" | "delete") =>
    void confirm(
      text("batchConfirm", { count: selected.length, action: text(action) }),
      async () => {
        const result = await onBatch(action, selected.map(String));
        if (result)
          setSelected((previous) =>
            previous.filter((id) => !result.succeeded.includes(String(id))),
          );
      },
    );
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <Input.Search
            style={{ width: 280, maxWidth: "100%" }}
            allowClear
            aria-label={text("searchDocuments")}
            placeholder={text("searchDocuments")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            aria-label={text("status")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: `${text("all")} (${docs.length})` },
              ...states.map((state) => ({
                value: state,
                label: `${text(`doc_${state}`)} (${counts.get(state)})`,
              })),
            ]}
          />
        </div>
        <Button onClick={onVersions}>{text("versionHistory")}</Button>
      </div>
      {selected.length > 0 && (
        <Space wrap>
          <Typography.Text>
            {text("selectedCount", { count: selected.length })}
          </Typography.Text>
          <Button disabled={busy} onClick={() => batch("publish")}>
            {text("publish")}
          </Button>
          <Button disabled={busy} onClick={() => batch("reparse")}>
            {text("reparse")}
          </Button>
          <Button danger disabled={busy} onClick={() => batch("delete")}>
            {text("archive")}
          </Button>
          <Button type="text" onClick={() => setSelected([])}>
            {text("clearSelection")}
          </Button>
        </Space>
      )}
      <Table<KnowledgeDocument>
        rowKey="id"
        loading={loading || busy}
        dataSource={filtered}
        scroll={{ x: 900 }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          preserveSelectedRowKeys: true,
        }}
        columns={[
          {
            title: text("document"),
            dataIndex: "title",
            width: 340,
            render: (title: string, doc) => (
              <div className={styles.titleCell}>
                <Button
                  type="link"
                  style={{
                    padding: 0,
                    maxWidth: "100%",
                    height: "auto",
                    whiteSpace: "normal",
                    textAlign: "start",
                  }}
                  onClick={() => onPreview(doc.id)}
                >
                  {title}
                </Button>
                {doc.error && (
                  <Typography.Paragraph
                    type="danger"
                    ellipsis={{ rows: 2, tooltip: doc.error }}
                  >
                    {doc.error}
                  </Typography.Paragraph>
                )}
              </div>
            ),
          },
          {
            title: text("status"),
            dataIndex: "status",
            width: 110,
            render: (status) => <DocumentStatus status={status} />,
          },
          {
            title: text("source"),
            width: 140,
            render: (_, doc) => (
              <Space orientation="vertical" size={2}>
                <span>{text(`tier_${doc.sourceTier}`)}</span>
                <Typography.Text type="secondary">
                  {text(`access_${doc.access}`)} · {doc.sourceType}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: text("version"),
            dataIndex: "version",
            width: 80,
            render: (version) => (
              <span className={styles.mono}>#{version}</span>
            ),
          },
          {
            title: text("created"),
            dataIndex: "createdAt",
            width: 130,
            render: (value) => new Date(value).toLocaleDateString(),
          },
          {
            title: text("actions"),
            width: 250,
            render: (_, doc) => (
              <Space wrap size={4}>
                <Button size="small" onClick={() => onPreview(doc.id)}>
                  {text("preview")}
                </Button>
                <Button size="small" onClick={() => onLogs(doc.id)}>
                  {text("logs")}
                </Button>
                {doc.status === "indexed" && (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() =>
                      void confirm(`${text("publish")} · ${doc.title}`, () =>
                        onAction(doc.id, "publish"),
                      )
                    }
                  >
                    {text("publish")}
                  </Button>
                )}
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "reparse", label: text("reparse") },
                      { key: "archive", label: text("archive"), danger: true },
                      ...(doc.status !== "published" && doc.version === 0
                        ? [{ key: "purge", label: text("purge"), danger: true }]
                        : []),
                    ],
                    onClick: ({ key }) => {
                      if (key === "reparse")
                        void confirm(`${text("reparse")} · ${doc.title}`, () =>
                          onAction(doc.id, "reparse"),
                        );
                      else if (key === "archive")
                        void confirm(
                          `${text("archive")} · ${doc.title} · ${text("archiveHint")}`,
                          () => onDelete(doc.id),
                        );
                      else if (key === "purge")
                        void confirm(
                          `${text("purgeConfirm")} · ${doc.title}`,
                          () => onDelete(doc.id, true),
                        );
                    },
                  }}
                >
                  <Button size="small" disabled={busy}>
                    {text("more")}
                  </Button>
                </Dropdown>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
