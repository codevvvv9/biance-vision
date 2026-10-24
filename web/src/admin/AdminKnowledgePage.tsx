import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Documents } from "./features/knowledge/Documents";
import {
  batchDocuments,
  deleteDocument,
  documentAction,
  loadDocuments,
  type BatchResult,
} from "./features/knowledge/api";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { AdminViews } from "./ui/views";
import { Feedback } from "./ui/feedback";
import CasesPanel from "./knowledge/CasesPanel";
import RuleCardsPanel from "./knowledge/RuleCardsPanel";
import SearchDebugPanel from "./knowledge/SearchDebugPanel";
import UploadDialog from "./knowledge/UploadDialog";
import ManifestDialog from "./knowledge/ManifestDialog";
import ParseLogDrawer from "./knowledge/ParseLogDrawer";
import PreviewDrawer from "./knowledge/PreviewDrawer";
import VersionHistoryDialog from "./knowledge/VersionHistoryDialog";
import { useDocPolling } from "./knowledge/hooks/useDocPolling";
import styles from "./ui/admin.module.css";
export default function AdminKnowledgePage(): JSX.Element {
  const text = useAdminText();
  const resource = useResource(loadDocuments);
  const docs = resource.data?.documents ?? [];
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [partial, setPartial] = useState("");
  const [dialog, setDialog] = useState<
    "upload" | "manifest" | "versions" | null
  >(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [logsId, setLogsId] = useState<string | null>(null);
  const delayed = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(delayed.current), []);
  const refreshSoon = () => {
    clearTimeout(delayed.current);
    delayed.current = setTimeout(() => void resource.reload(), 1500);
  };
  const refresh = () => {
    void resource.reload();
    refreshSoon();
  };
  const { workerDead } = useDocPolling(docs, () => void resource.reload());
  const run = async (operation: () => Promise<unknown>) => {
    setError("");
    setSuccess("");
    setPartial("");
    try {
      await operation();
      setSuccess(text("operationDone"));
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const batch = async (
    action: "publish" | "reparse" | "delete",
    ids: string[],
  ): Promise<BatchResult | undefined> => {
    setError("");
    setSuccess("");
    setPartial("");
    try {
      const result = await batchDocuments(action, ids);
      const message = text("batchResult", {
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      });
      if (result.failed.length)
        setPartial(
          `${message} · ${result.failed.map((item) => `${item.id}: ${item.error}`).join("; ")}`,
        );
      else setSuccess(message);
      await resource.reload();
      if (action === "reparse") refreshSoon();
      return result;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className={styles.stack}>
      <Feedback error={error || resource.error} success={success} />
      {partial && <Alert type="warning" title={partial} showIcon />}
      {workerDead && (
        <Alert type="warning" title={text("workerUnavailable")} showIcon />
      )}
      <AdminViews
        items={[
          {
            key: "documents",
            label: "documents",
            children: (
              <Card>
                <div className={styles.toolbar}>
                  <Space wrap>
                    <Tag>{text("documentCount", { count: docs.length })}</Tag>
                    <Tag color="success">
                      {text("publishedCount", {
                        count: docs.filter((doc) => doc.status === "published")
                          .length,
                      })}
                    </Tag>
                  </Space>
                  <Space wrap>
                    <Button onClick={() => setDialog("manifest")}>
                      {text("manifestImport")}
                    </Button>
                    <Button
                      type="primary"
                      icon={<PlusOutlined aria-hidden />}
                      onClick={() => setDialog("upload")}
                    >
                      {text("uploadDocuments")}
                    </Button>
                  </Space>
                </div>
                <Documents
                  docs={docs}
                  loading={resource.loading}
                  onPreview={setPreviewId}
                  onLogs={setLogsId}
                  onVersions={() => setDialog("versions")}
                  onAction={(id, action) =>
                    run(async () => {
                      await documentAction(id, action);
                      if (action === "reparse") refreshSoon();
                    })
                  }
                  onDelete={(id, purge) => run(() => deleteDocument(id, purge))}
                  onBatch={batch}
                />
              </Card>
            ),
          },
          {
            key: "rules",
            label: "ruleCards",
            children: <RuleCardsPanel onError={setError} />,
          },
          {
            key: "cases",
            label: "cases",
            children: <CasesPanel onError={setError} />,
          },
          {
            key: "search",
            label: "searchDebug",
            children: <SearchDebugPanel onError={setError} />,
          },
        ]}
      />
      <>
        {previewId && (
          <PreviewDrawer
            key={previewId}
            docId={previewId}
            onClose={() => setPreviewId(null)}
            onChanged={refresh}
          />
        )}
        {logsId && (
          <ParseLogDrawer
            key={logsId}
            docId={logsId}
            onClose={() => setLogsId(null)}
          />
        )}
        {dialog === "versions" && (
          <VersionHistoryDialog
            onClose={() => setDialog(null)}
            onRestored={refresh}
          />
        )}
        {dialog === "upload" && (
          <UploadDialog
            onClose={() => setDialog(null)}
            onDone={refresh}
            onOpenManifest={() => setDialog("manifest")}
          />
        )}
        {dialog === "manifest" && (
          <ManifestDialog
            onClose={() => setDialog(null)}
            onImported={refresh}
          />
        )}
      </>
    </div>
  );
}
