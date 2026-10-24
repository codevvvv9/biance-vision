import { Modal } from "../ui/overlays";
import { useAdminText } from "../ui/text";
import {
  Alert,
  Button,
  Input,
  Progress,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from "antd";
import styles from "../ui/admin.module.css";
import { useDirtyForm, useConfirmDiscard } from "../ui/forms";
/**
 * W2 上传队列对话框（docs/knowledge-ui-redesign-plan.md 流程 1，重构替代 ImportZone 的文件区）：
 * - 入队三道校验（各自报错、带文件名）：格式 / 大小 ≤50MB / name+size 队列内重复
 *   + contentHash 服务端预检（POST documents/precheck，重复标黄不入队上传）；
 * - 队列区逐文件行：类型角标+文件名+大小+状态+单文件移除；串行上传（XHR 进度百分比），
 *   上传中行自动滚动进入视野；
 * - 元数据区：sourceTier × access 下拉（自绘 Dropdown，修 G3；受限级别带警示旁注）；
 * - 底部三钮：取消（= 回滚：abort 进行中 + purge 清本次已传文档）/ 开始上传（有就绪项才可用）/
 *   完成（有成功且无失败无进行中才可用）；
 * - URL 导入与清单批量导入在第二/三个 Tab（清单明细走 ManifestDialog 独立弹窗，流程 6）。
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../../api";

const ACCEPT = ".pdf,.docx,.txt,.md,.html";
const ALLOWED_EXT = ["pdf", "docx", "txt", "md", "html"];
const MAX_BYTES = 50 * 1024 * 1024;

type ItemState =
  | "checking"
  | "ready"
  | "duplicate"
  | "invalid"
  | "uploading"
  | "done"
  | "error";

interface QueueItem {
  key: string;
  file: File;
  state: ItemState;
  message?: string;
  progress: number;
  /** 本次会话新建的文档 id（取消回滚只清这些，不动服务端判重的既有文档） */
  docId?: string;
}

interface UploadOutcome {
  status?: string;
  message?: string;
  document?: { id: string } | null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** XHR 上传（fetch 无上传进度事件；abort 经返回的控制器外部触发） */
function xhrUpload(
  file: File,
  sourceTier: string,
  access: string,
  onProgress: (pct: number) => void,
): { promise: Promise<UploadOutcome>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadOutcome>((resolve, reject) => {
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let data: UploadOutcome = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadOutcome;
      } catch {
        /* 非 JSON 响应按错误处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.message ?? `HTTP ${xhr.status}`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
    const form = new FormData();
    form.append("file", file);
    form.append("title", file.name);
    form.append("sourceTier", sourceTier);
    form.append("access", access);
    xhr.open("POST", "/api/admin/knowledge/documents");
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export default function UploadDialog({
  onClose,
  onDone,
  onOpenManifest,
}: {
  onClose: () => void;
  onDone: () => void;
  onOpenManifest: () => void;
}): JSX.Element | null {
  const text = useAdminText();
  const discard = useConfirmDiscard();
  const [tab, setTab] = useState<"files" | "url" | "manifest">("files");
  const [items, setQueue] = useState<QueueItem[]>([]);
  const itemsRef = useRef(items);
  const aliveRef = useRef(true);
  const cancelledRef = useRef(false);
  const uploadTaskRef = useRef<Promise<void> | null>(null);
  const setItems = (
    update: QueueItem[] | ((previous: QueueItem[]) => QueueItem[]),
  ): void => {
    const next =
      typeof update === "function" ? update(itemsRef.current) : update;
    itemsRef.current = next;
    if (aliveRef.current) setQueue(next);
  };
  const [sourceTier, setSourceTier] = useState<
    "community" | "official" | "official_derivative"
  >("community");
  const [access, setAccess] = useState<"public" | "purchase" | "member">(
    "public",
  );
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMsg, setUrlMsg] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const urlTaskRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);

  /** 入队 + 三道校验（格式 / 大小 / name+size 重复）+ contentHash 服务端预检 */
  const enqueue = (files: FileList | File[]): void => {
    const incoming = Array.from(files);
    const additions: QueueItem[] = [];
    const nextItems = [...itemsRef.current];
    for (const file of incoming) {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      const key = `${file.name}:${file.size}:${(seqRef.current += 1)}`;
      if (!ALLOWED_EXT.includes(ext)) {
        additions.push({
          key,
          file,
          state: "invalid",
          progress: 0,
          message: text("unsupportedFormat", {
            extension: ext,
            formats: ACCEPT,
          }),
        });
        continue;
      }
      if (file.size > MAX_BYTES) {
        additions.push({
          key,
          file,
          state: "invalid",
          progress: 0,
          message: text("fileTooLarge", { size: formatBytes(file.size) }),
        });
        continue;
      }
      if (
        [...nextItems, ...additions].some(
          (it) =>
            it.file.name === file.name &&
            it.file.size === file.size &&
            it.state !== "invalid",
        )
      ) {
        additions.push({
          key,
          file,
          state: "invalid",
          progress: 0,
          message: text("duplicateQueue"),
        });
        continue;
      }
      additions.push({ key, file, state: "checking", progress: 0 });
    }
    const merged = [...nextItems, ...additions];
    setItems(merged);
    // contentHash 预检（第三道）：逐个算指纹 → 服务端查重
    for (const item of additions) {
      if (item.state !== "checking") continue;
      void (async () => {
        let duplicate = false;
        let existingTitle: string | null = null;
        try {
          const hash = await sha256Hex(item.file);
          const r = await api<{
            duplicate: boolean;
            existingTitle: string | null;
          }>("/admin/knowledge/documents/precheck", {
            method: "POST",
            body: { contentHash: hash },
          });
          duplicate = r.duplicate;
          existingTitle = r.existingTitle;
        } catch {
          // 预检失败不阻塞：放行上传，服务端上传时仍会兜底查重
        }
        setItems((prev) =>
          prev.map((it) =>
            it.key === item.key && it.state === "checking"
              ? {
                  ...it,
                  state: duplicate ? "duplicate" : "ready",
                  message: duplicate
                    ? text("duplicateContent", { title: existingTitle ?? "" })
                    : undefined,
                }
              : it,
          ),
        );
      })();
    }
  };

  /** 串行上传就绪项；上传中行滚动进入视野 */
  const performUpload = async (): Promise<void> => {
    cancelledRef.current = false;
    setUploading(true);
    try {
      for (;;) {
        if (cancelledRef.current || !aliveRef.current) break;
        const target = itemsRef.current.find((it) => it.state === "ready");
        if (target === undefined) break;
        setItems((prev) =>
          prev.map((it) =>
            it.key === target.key
              ? { ...it, state: "uploading", progress: 0 }
              : it,
          ),
        );
        listRef.current
          ?.querySelector(`[data-row-key="${CSS.escape(target.key)}"]`)
          ?.scrollIntoView({ block: "nearest" });
        const { promise, abort } = xhrUpload(
          target.file,
          sourceTier,
          access,
          (pct) => {
            setItems((prev) =>
              prev.map((it) =>
                it.key === target.key && it.state === "uploading"
                  ? { ...it, progress: pct }
                  : it,
              ),
            );
          },
        );
        abortRef.current = abort;
        try {
          const r = await promise;
          setItems((prev) =>
            prev.map((it) =>
              it.key === target.key
                ? {
                    ...it,
                    state: r.status === "duplicate" ? "duplicate" : "done",
                    progress: 100,
                    docId:
                      r.status === "duplicate"
                        ? undefined
                        : (r.document?.id ?? undefined),
                    message:
                      r.status === "duplicate"
                        ? text("serverDuplicate")
                        : undefined,
                  }
                : it,
            ),
          );
        } catch (e) {
          const err = e as Error;
          setItems((prev) =>
            prev.map((it) =>
              it.key === target.key
                ? {
                    ...it,
                    state: "error",
                    message:
                      err.name === "AbortError"
                        ? text("uploadAborted")
                        : err.message,
                  }
                : it,
            ),
          );
          if (err.name === "AbortError") break;
        } finally {
          abortRef.current = null;
        }
      }
    } finally {
      if (aliveRef.current) {
        setUploading(false);
        onDone();
      }
    }
  };
  const startUpload = (): Promise<void> => {
    if (uploadTaskRef.current) return uploadTaskRef.current;
    const task = performUpload().finally(() => {
      uploadTaskRef.current = null;
    });
    uploadTaskRef.current = task;
    return task;
  };

  /** 取消 = 回滚：abort 进行中 + purge 本次已新建的文档（不动服务端判重命中的既有文档） */
  const rollbackCreated = async (): Promise<void> => {
    cancelledRef.current = true;
    abortRef.current?.();
    await uploadTaskRef.current;
    await urlTaskRef.current;
    const created = itemsRef.current.filter((it) => it.docId !== undefined);
    for (const it of created) {
      try {
        await api(`/admin/knowledge/documents/${it.docId}?purge=1`, {
          method: "DELETE",
        });
        setItems((previous) =>
          previous.map((item) =>
            item.key === it.key ? { ...item, docId: undefined } : item,
          ),
        );
      } catch (error) {
        if (aliveRef.current)
          setUrlMsg(
            text("rollbackFailed", { error: (error as Error).message }),
          );
        throw error;
      }
    }
    if (created.length > 0) onDone();
  };
  const cancelAndRollback = async (): Promise<void> => {
    try {
      await rollbackCreated();
      onClose();
    } catch {
      /* Keep the dialog mounted for retry. */
    }
  };

  const performUrlImport = async (): Promise<void> => {
    setUrlBusy(true);
    setUrlMsg("");
    try {
      const r = await api<{ status: string }>(
        "/admin/knowledge/documents/import-url",
        {
          method: "POST",
          body: { url, sourceTier, access },
        },
      );
      setUrlMsg(
        r.status === "duplicate"
          ? text("serverDuplicate")
          : text("importQueued"),
      );
      setUrl("");
      onDone();
    } catch (e) {
      setUrlMsg((e as Error).message);
    } finally {
      setUrlBusy(false);
    }
  };

  const importUrl = (): Promise<void> => {
    if (urlTaskRef.current) return urlTaskRef.current;
    const task = performUrlImport().finally(() => {
      urlTaskRef.current = null;
    });
    urlTaskRef.current = task;
    return task;
  };

  const removeItem = (key: string): void => {
    // 上传中/已完成项不可移除（前者防半传、后者已是服务端状态，走取消回滚或列表管理）
    setItems((prev) =>
      prev.filter(
        (it) =>
          it.key !== key || it.state === "uploading" || it.state === "done",
      ),
    );
  };

  useDirtyForm(
    items.length > 0 || url !== "" || uploading || urlBusy,
    rollbackCreated,
  );
  const requestManifest = async (): Promise<void> => {
    if (await discard(items.length > 0 || url !== "")) {
      try {
        await rollbackCreated();
        onOpenManifest();
      } catch {
        /* Keep cleanup failures visible. */
      }
    }
  };
  const requestClose = async (): Promise<void> => {
    if (uploading || urlBusy) return;
    if (await discard(items.length > 0 || url !== ""))
      await cancelAndRollback();
  };

  const readyCount = items.filter((it) => it.state === "ready").length;
  const doneCount = items.filter((it) => it.state === "done").length;
  const failedCount = items.filter(
    (it) => it.state === "error" || it.state === "invalid",
  ).length;
  const canFinish = doneCount > 0 && failedCount === 0 && !uploading;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelledRef.current = true;
      abortRef.current?.();
    };
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) enqueue(e.dataTransfer.files);
  };

  const metadata = (
    <Space wrap align="start">
      <label className={styles.field}>
        {text("source")}
        <Select
          aria-label={text("source")}
          value={sourceTier}
          disabled={uploading || urlBusy}
          style={{ width: 180 }}
          options={(
            ["community", "official", "official_derivative"] as const
          ).map((value) => ({ value, label: text(`tier_${value}`) }))}
          onChange={setSourceTier}
        />
      </label>
      <label className={styles.field}>
        {text("access")}
        <Select
          aria-label={text("access")}
          value={access}
          disabled={uploading || urlBusy}
          style={{ width: 180 }}
          options={(["public", "purchase", "member"] as const).map((value) => ({
            value,
            label: text(`access_${value}`),
          }))}
          onChange={setAccess}
        />
      </label>
    </Space>
  );
  return (
    <Modal
      open
      title={text("uploadDocuments")}
      width={900}
      footer={null}
      onCancel={() => void requestClose()}
      keyboard={!uploading && !urlBusy}
      maskClosable={!uploading && !urlBusy}
    >
      <div className={styles.stack}>
        {urlMsg && <Alert title={urlMsg} type="info" showIcon />}
        <Tabs
          activeKey={tab}
          onChange={(value) => setTab(value as typeof tab)}
          items={[
            {
              key: "files",
              label: text("files"),
              children: (
                <div className={styles.stack}>
                  {metadata}
                  {access !== "public" && (
                    <Alert
                      type="warning"
                      showIcon
                      title={text("restrictedAccess")}
                    />
                  )}
                  <div
                    className={styles.dropzone}
                    data-dragging={dragging}
                    role="button"
                    tabIndex={0}
                    aria-label={text("addFiles")}
                    onClick={() => inputRef.current?.click()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        inputRef.current?.click();
                      }
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                  >
                    <input
                      ref={inputRef}
                      type="file"
                      accept={ACCEPT}
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.target.files?.length)
                          enqueue(event.target.files);
                        event.target.value = "";
                      }}
                    />
                    <strong>{text("addFiles")}</strong>
                    <p>{text("uploadHint")}</p>
                  </div>
                  <div ref={listRef}>
                    <Table<QueueItem>
                      rowKey="key"
                      size="small"
                      dataSource={items}
                      pagination={false}
                      scroll={{ x: 680, y: 320 }}
                      columns={[
                        {
                          title: text("document"),
                          dataIndex: "file",
                          width: 280,
                          render: (file: File) => (
                            <div className={styles.titleCell} title={file.name}>
                              {file.name}
                            </div>
                          ),
                        },
                        {
                          title: text("fileSize"),
                          width: 90,
                          render: (_, item) => formatBytes(item.file.size),
                        },
                        {
                          title: text("status"),
                          width: 240,
                          render: (_, item) => (
                            <>
                              <Tag
                                color={
                                  item.state === "done"
                                    ? "success"
                                    : item.state === "invalid" ||
                                        item.state === "error"
                                      ? "error"
                                      : item.state === "duplicate"
                                        ? "warning"
                                        : "default"
                                }
                              >
                                {text(`queue_${item.state}`)}
                              </Tag>
                              {item.message && (
                                <div
                                  role={
                                    item.state === "error" ||
                                    item.state === "invalid"
                                      ? "alert"
                                      : undefined
                                  }
                                >
                                  {item.message}
                                </div>
                              )}
                              {item.state === "uploading" && (
                                <Progress
                                  percent={item.progress}
                                  size="small"
                                />
                              )}
                            </>
                          ),
                        },
                        {
                          title: text("actions"),
                          width: 90,
                          render: (_, item) =>
                            item.state !== "uploading" &&
                            item.state !== "done" && (
                              <Button
                                size="small"
                                aria-label={text("removeFile", {
                                  name: item.file.name,
                                })}
                                onClick={() => removeItem(item.key)}
                              >
                                {text("remove")}
                              </Button>
                            ),
                        },
                      ]}
                    />
                  </div>
                  <Space wrap>
                    <Button
                      disabled={urlBusy}
                      onClick={() => void cancelAndRollback()}
                    >
                      {text(
                        items.some((item) => item.docId !== undefined)
                          ? "cancelRollback"
                          : "cancel",
                      )}
                    </Button>
                    <Button
                      type="primary"
                      loading={uploading}
                      disabled={readyCount === 0}
                      onClick={() => void startUpload()}
                    >
                      {text("startUpload", { count: readyCount })}
                    </Button>
                    <Button disabled={!canFinish} onClick={onClose}>
                      {text("finish")}
                    </Button>
                  </Space>
                </div>
              ),
            },
            {
              key: "url",
              label: "URL",
              children: (
                <div className={styles.stack}>
                  {metadata}
                  <Input.Search
                    aria-label={text("sourceUrl")}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://…"
                    enterButton={text("import")}
                    loading={urlBusy}
                    disabled={urlBusy || uploading}
                    onSearch={() => {
                      if (url.trim()) void importUrl();
                    }}
                  />
                  <p>{text("urlPolicy")}</p>
                </div>
              ),
            },
            {
              key: "manifest",
              label: text("manifestImport"),
              children: (
                <div className={styles.stack}>
                  <p>{text("manifestHint")}</p>
                  <Button
                    type="primary"
                    disabled={uploading || urlBusy}
                    onClick={() => void requestManifest()}
                  >
                    {text("openManifest")}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </div>
    </Modal>
  );
}
