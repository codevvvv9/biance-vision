import { Alert } from "antd";
import { Feedback } from "../ui/feedback";
import styles from "../ui/admin.module.css";
import { Space, Table, Tag, Typography } from "antd";
import { Modal } from "../ui/overlays";
import { useAdminText } from "../ui/text";
import { Button } from "antd";
/**
 * W2 清单批量导入弹窗（docs/knowledge-ui-redesign-plan.md 流程 6，修 G1）：
 * - 展示 knowledge_manifest_entries 全部条目（标题/URL/导入状态/最近错误）——
 *   状态来自 DB（GET manifest-entries），不再只看构建副本；
 * - 「从默认清单重新同步」：把 default-manifest.json upsert 入库（仅同步条目，不抓取）；
 * - 勾选条目提交导入（POST import-manifest——修 entries 传参即修 400 坏死）；
 *   仅 enabled + url_fetch + public 的条目可勾选/单条重试（受限资料走文件上传，不绕过）；
 * - 导入结果部分失败汇报（新/重复/失败/待上传 + 失败明细）。
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { KnowledgeManifestEntryStatus } from "biance-vision-brooks";
import defaultManifest from "./default-manifest.json";

interface ManifestEntryInput {
  id: string;
  url: string;
  type: string;
  title: string;
  topics: string[];
  access: string;
  sourceTier: string;
  importMethod: string;
  enabled: boolean;
  notes?: string;
}

const DEFAULT_ENTRIES = (defaultManifest as { entries: ManifestEntryInput[] })
  .entries;

/** 可导入判定：启用 + 自动抓取 + 公开（与后端 import-manifest 的放行分支一致） */
function importable(e: KnowledgeManifestEntryStatus): boolean {
  return e.enabled && e.importMethod === "url_fetch" && e.access === "public";
}

export default function ManifestDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}): JSX.Element | null {
  const text = useAdminText();
  const [entries, setEntries] = useState<KnowledgeManifestEntryStatus[] | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summaryMsg, setSummaryMsg] = useState("");
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ entries: KnowledgeManifestEntryStatus[] }>(
      "/admin/knowledge/manifest-entries",
    )
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setSelected(
          new Set(
            r.entries
              .filter(importable)
              .filter((e) => e.status !== "imported")
              .map((e) => e.id),
          ),
        );
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const reload = async (): Promise<void> => {
    const r = await api<{ entries: KnowledgeManifestEntryStatus[] }>(
      "/admin/knowledge/manifest-entries",
    );
    setEntries(r.entries);
  };

  const syncFromDefault = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        synced: number;
        entries: KnowledgeManifestEntryStatus[];
      }>("/admin/knowledge/manifest-entries/sync", {
        method: "POST",
        body: { entries: DEFAULT_ENTRIES },
      });
      setEntries(r.entries);
      setPartial(false);
      setSummaryMsg(text("manifestSynced", { count: r.synced }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importEntries = async (
    targets: KnowledgeManifestEntryStatus[],
  ): Promise<void> => {
    if (targets.length === 0) return;
    setBusy(true);
    setError("");
    setPartial(false);
    setSummaryMsg(text("manifestImporting"));
    try {
      // 提交勾选条目的完整字段（与 default-manifest 同构；url_fetch 自动抓取）——DB 行即真源
      const payload = targets.map((e) => ({
        id: e.id,
        url: e.url,
        type: e.type,
        title: e.title,
        topics: e.topics,
        access: e.access,
        sourceTier: e.sourceTier,
        importMethod: e.importMethod,
        enabled: e.enabled,
        ...(e.notes !== null && e.notes !== "" ? { notes: e.notes } : {}),
      }));
      const r = await api<{
        summary: {
          imported: number;
          duplicates: number;
          failed: number;
          pendingUpload: number;
        };
        failures: { id: string; error: string }[];
      }>("/admin/knowledge/documents/import-manifest", {
        method: "POST",
        body: { entries: payload },
      });
      const s = r.summary;
      setPartial(s.failed > 0);
      setSummaryMsg(
        text("manifestSummary", s) +
          (r.failures.length
            ? ` · ${r.failures.map((f) => `${f.id}: ${f.error.slice(0, 80)}`).join("; ")}`
            : ""),
      );
      await reload();
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importableEntries = (entries ?? []).filter(importable);
  const selectedEntries = importableEntries.filter((e) => selected.has(e.id));

  return (
    <Modal
      open
      title={text("manifestImport")}
      width={1100}
      footer={null}
      onCancel={busy ? undefined : onClose}
      keyboard={!busy}
      maskClosable={!busy}
    >
      <div className={styles.stack}>
        <Feedback error={error} />
        <div className={styles.toolbar}>
          <Typography.Text type="secondary">
            {text("manifestAccessHint")}
          </Typography.Text>
          <Button disabled={busy} onClick={() => void syncFromDefault()}>
            {text("syncManifest")}
          </Button>
        </div>
        {summaryMsg && (
          <Alert type={partial ? "warning" : "success"} title={summaryMsg} />
        )}
        <Table<KnowledgeManifestEntryStatus>
          rowKey="id"
          dataSource={entries ?? []}
          loading={entries === null || busy}
          scroll={{ x: 950 }}
          rowSelection={{
            selectedRowKeys: [...selected],
            onChange: (keys) => setSelected(new Set(keys.map(String))),
            getCheckboxProps: (entry) => ({
              disabled: !importable(entry) || busy,
            }),
          }}
          columns={[
            {
              title: text("document"),
              width: 330,
              render: (_, entry) => (
                <div className={styles.titleCell}>
                  <Typography.Text strong>{entry.title}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary">
                    {entry.url}
                  </Typography.Text>
                </div>
              ),
            },
            {
              title: text("source"),
              render: (_, entry) => (
                <Space orientation="vertical" size={2}>
                  <span>{entry.importMethod}</span>
                  <span>
                    {text(`access_${entry.access}`)}
                    {!entry.enabled && ` · ${text("disabled")}`}
                  </span>
                </Space>
              ),
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => (
                <Tag
                  color={
                    status === "failed"
                      ? "error"
                      : status === "imported"
                        ? "success"
                        : undefined
                  }
                >
                  {text(`manifest_${status}`)}
                </Tag>
              ),
            },
            {
              title: text("lastError"),
              dataIndex: "lastError",
              ellipsis: true,
            },
            {
              title: text("actions"),
              render: (_, entry) =>
                importable(entry) &&
                (entry.status === "failed" || entry.status === "skipped") && (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => void importEntries([entry])}
                  >
                    {text("retry")}
                  </Button>
                ),
            },
          ]}
        />
        <div className={styles.toolbar}>
          <Typography.Text>
            {text("manifestSelected", {
              selected: selectedEntries.length,
              available: importableEntries.length,
            })}
          </Typography.Text>
          <Button
            type="primary"
            loading={busy}
            disabled={!selectedEntries.length}
            onClick={() => void importEntries(selectedEntries)}
          >
            {text("importSelected")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
