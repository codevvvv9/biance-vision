import { Modal, overlayContainer } from "./ui/overlays";
import { useState } from "react";
import { App, Button, Card, Space, Table, Tag } from "antd";
import type { AgentVersion } from "biance-vision-brooks";
import {
  agentVersionAction,
  debugAgent,
  loadAgentVersions,
  loadAgentCapabilities,
  type DebugRun,
} from "./features/agents/api";
import { Capabilities } from "./features/agents/Capabilities";
import { VersionEditor } from "./features/agents/VersionEditor";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { AdminViews } from "./ui/views";
import { Feedback, Loading } from "./ui/feedback";
import styles from "./ui/admin.module.css";
function Versions(): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadAgentVersions);
  const [editor, setEditor] = useState<AgentVersion | "new" | null>(null);
  const [debug, setDebug] = useState<DebugRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const act = async (version: AgentVersion, action: "publish" | "rollback") => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text(action)} · ${version.label}`,
        content: text("versionImpact"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await agentVersionAction(version.id, action);
      setSuccess(text("operationDone"));
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const versions = resource.data?.versions ?? [];
  const current = versions.find(
    (version) => version.id === resource.data?.currentVersionId,
  );
  return (
    <div className={styles.stack}>
      <Feedback error={error || resource.error} success={success} />
      <Card>
        <div className={styles.toolbar}>
          <span>{text("versionImpact")}</span>
          <Button type="primary" onClick={() => setEditor("new")}>
            {text("newDraft")}
          </Button>
        </div>
        <Table<AgentVersion>
          loading={resource.loading || busy}
          rowKey="id"
          dataSource={versions}
          scroll={{ x: 700 }}
          columns={[
            {
              title: text("versionLabel"),
              dataIndex: "label",
              render: (label, version) => (
                <Space>
                  {label}
                  {current?.id === version.id && (
                    <Tag color="success">{text("current")}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => <Tag>{text(status)}</Tag>,
            },
            {
              title: text("created"),
              dataIndex: "createdAt",
              render: (value) => new Date(value).toLocaleString(),
            },
            {
              title: text("actions"),
              render: (_, version) => (
                <Space wrap>
                  {version.status === "draft" && (
                    <>
                      <Button size="small" onClick={() => setEditor(version)}>
                        {text("edit")}
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => void act(version, "publish")}
                      >
                        {text("publish")}
                      </Button>
                    </>
                  )}
                  {version.status === "published" &&
                    current?.id !== version.id && (
                      <Button
                        size="small"
                        onClick={() => void act(version, "rollback")}
                      >
                        {text("rollback")}
                      </Button>
                    )}
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void debugAgent(version.id)
                        .then(setDebug)
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {text("debugRun")}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {editor && (
        <VersionEditor
          key={editor === "new" ? "new" : editor.id}
          version={editor === "new" ? undefined : editor}
          current={current}
          onClose={() => setEditor(null)}
          onSaved={() => void resource.reload()}
        />
      )}
      <Modal
        title={text("debugRun")}
        open={debug !== null}
        footer={null}
        onCancel={() => setDebug(null)}
      >
        <pre className={styles.pre}>{JSON.stringify(debug, null, 2)}</pre>
      </Modal>
    </div>
  );
}

function CapabilitySettings(): JSX.Element {
  const resource = useResource(loadAgentCapabilities);
  return (
    <div className={styles.stack}>
      <Feedback error={resource.error} />
      {resource.data ? (
        <Capabilities
          initial={resource.data.capabilities}
          source={resource.data.source}
          onSaved={() => void resource.reload()}
        />
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </div>
  );
}
export default function AdminAgentsPage(): JSX.Element {
  return (
    <AdminViews
      items={[
        {
          key: "capabilities",
          label: "capabilities",
          children: <CapabilitySettings />,
        },
        { key: "versions", label: "versions", children: <Versions /> },
      ]}
    />
  );
}
