import { useState } from "react";
import { App, Button, Table, Tag, Typography } from "antd";
import type { KnowledgeVersionSummary } from "biance-vision-brooks";
import { api } from "../../api";
import { Modal, overlayContainer } from "../ui/overlays";
import { useResource } from "../ui/resource";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
const loadVersions = () =>
  api<{ versions: KnowledgeVersionSummary[] }>("/admin/knowledge/versions");
export default function VersionHistoryDialog({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadVersions);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const restore = async (version: KnowledgeVersionSummary) => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text("rollback")} · ${version.label}`,
        content: text("restoreKnowledgeHint"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/admin/knowledge/versions/${encodeURIComponent(version.id)}/restore`,
        { method: "POST", body: {} },
      );
      onRestored();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={text("versionHistory")}
      width={1000}
      footer={null}
      onCancel={busy ? undefined : onClose}
      keyboard={!busy}
      maskClosable={!busy}
    >
      <Feedback error={error || resource.error} />
      <Typography.Paragraph type="secondary">
        {text("restoreKnowledgeHint")}
      </Typography.Paragraph>
      <Table<KnowledgeVersionSummary>
        rowKey="id"
        dataSource={resource.data?.versions ?? []}
        loading={resource.loading || busy}
        scroll={{ x: 750 }}
        columns={[
          {
            title: text("version"),
            dataIndex: "label",
            render: (label, _, index) => (
              <>
                {label}{" "}
                {index === 0 && <Tag color="success">{text("current")}</Tag>}
              </>
            ),
          },
          {
            title: text("created"),
            dataIndex: "createdAt",
            render: (value) => new Date(value).toLocaleString(),
          },
          { title: text("documents"), dataIndex: "docCount" },
          { title: text("createdBy"), dataIndex: "createdBy" },
          { title: text("note"), dataIndex: "note" },
          {
            title: text("actions"),
            render: (_, version, index) =>
              index > 0 && (
                <Button size="small" onClick={() => void restore(version)}>
                  {text("rollback")}
                </Button>
              ),
          },
        ]}
      />
    </Modal>
  );
}
