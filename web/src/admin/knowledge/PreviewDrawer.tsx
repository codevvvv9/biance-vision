import { useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Space,
  Tabs,
  Tag,
} from "antd";
import type { KnowledgeDocument } from "biance-vision-brooks";
import { api } from "../../api";
import MiniMarkdown from "../../components/MiniMarkdown";
import { Drawer, overlayContainer } from "../ui/overlays";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
import styles from "../ui/admin.module.css";

interface PreviewChunk {
  chunkId: string;
  pageNo?: number;
  figureId?: string;
  kind: string;
  text: string;
}
interface DocPreview {
  document: KnowledgeDocument;
  parseMeta: Record<string, unknown>;
  chunks: PreviewChunk[];
  vector: { support: string; note: string };
}
type RawLoad = {
  state:
    | "loading"
    | "iframe"
    | "markdown"
    | "text"
    | "unsupported"
    | "missing"
    | "error";
  url?: string;
  text?: string;
  message?: string;
};

export default function PreviewDrawer({
  docId,
  onClose,
  onChanged,
}: {
  docId: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("chunks");
  const [full, setFull] = useState<Record<string, string>>({});
  const [rawRequested, setRawRequested] = useState(false);
  const [raw, setRaw] = useState<RawLoad | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    api<DocPreview>(`/admin/knowledge/documents/${docId}/preview`)
      .then((value) => {
        if (current) setPreview(value);
      })
      .catch((e: Error) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [docId]);
  // Keep the request and object URL alive across tab changes; release both on document unmount.
  useEffect(() => {
    if (!rawRequested) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setRaw({ state: "loading" });
    void (async () => {
      try {
        const response = await fetch(
          `/api/admin/knowledge/documents/${docId}/file`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            message?: string;
          };
          if (!controller.signal.aborted)
            setRaw({
              state: response.status === 404 ? "missing" : "error",
              message: data.message ?? `HTTP ${response.status}`,
            });
          return;
        }
        const type = response.headers.get("content-type") ?? "";
        if (
          type.startsWith("application/pdf") ||
          type.startsWith("text/html")
        ) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setRaw({ state: "iframe", url: objectUrl });
        } else if (
          type.startsWith("text/markdown") ||
          type.startsWith("text/plain")
        ) {
          const value = await response.text();
          if (!controller.signal.aborted)
            setRaw({
              state: type.startsWith("text/markdown") ? "markdown" : "text",
              text: value,
            });
        } else if (!controller.signal.aborted) setRaw({ state: "unsupported" });
      } catch (e) {
        if (!controller.signal.aborted)
          setRaw({ state: "error", message: (e as Error).message });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, rawRequested]);
  const loadFull = async (id: string): Promise<void> => {
    try {
      const value = await api<{ chunk: { text: string } }>(
        `/admin/knowledge/chunks/${id}`,
      );
      if (alive.current)
        setFull((previous) => ({ ...previous, [id]: value.chunk.text }));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };
  const action = async (kind: "publish" | "reparse"): Promise<void> => {
    if (
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: text(kind),
        content: `${preview?.document.title ?? docId} · ${text("operationImpact")}`,
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setError("");
    try {
      await api(`/admin/knowledge/documents/${docId}/${kind}`, {
        method: "POST",
        body: {},
      });
      onChanged();
      const value = await api<DocPreview>(
        `/admin/knowledge/documents/${docId}/preview`,
      );
      if (alive.current) setPreview(value);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };
  const doc = preview?.document;
  return (
    <Drawer
      open
      title={doc?.title ?? text("preview")}
      size={900}
      onClose={onClose}
    >
      <div className={styles.stack}>
        <Feedback error={error} />
        {doc && (
          <>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
              items={[
                {
                  key: "status",
                  label: text("status"),
                  children: <Tag>{text(`doc_${doc.status}`)}</Tag>,
                },
                {
                  key: "version",
                  label: text("version"),
                  children: `#${doc.version}`,
                },
                {
                  key: "tier",
                  label: text("source"),
                  children: text(`tier_${doc.sourceTier}`),
                },
                {
                  key: "access",
                  label: text("access"),
                  children: text(`access_${doc.access}`),
                },
              ]}
            />
            <Space wrap>
              {doc.status !== "parsing" && (
                <Button onClick={() => void action("reparse")}>
                  {text("reparse")}
                </Button>
              )}
              {doc.status === "indexed" && (
                <Button type="primary" onClick={() => void action("publish")}>
                  {text("publish")}
                </Button>
              )}
            </Space>
          </>
        )}
        <Tabs
          activeKey={tab}
          onChange={(key) => {
            setTab(key);
            if (key === "raw") setRawRequested(true);
          }}
          items={[
            {
              key: "chunks",
              label: `${text("chunks")} (${preview?.chunks.length ?? "…"})`,
              children: (
                <div className={styles.stack}>
                  {preview && (
                    <Collapse
                      items={[
                        {
                          key: "meta",
                          label: text("parseMetadata"),
                          children: (
                            <>
                              <p>{preview.vector.note}</p>
                              <pre className={styles.pre}>
                                {JSON.stringify(preview.parseMeta, null, 2)}
                              </pre>
                            </>
                          ),
                        },
                      ]}
                    />
                  )}
                  {preview?.chunks.map((chunk) => (
                    <Card
                      key={chunk.chunkId}
                      size="small"
                      title={
                        <Space wrap>
                          <Tag>#{chunk.chunkId.slice(0, 8)}</Tag>
                          {chunk.pageNo != null && (
                            <Tag>
                              {text("pageNumber", { page: chunk.pageNo })}
                            </Tag>
                          )}
                          {chunk.figureId && <Tag>{chunk.figureId}</Tag>}
                          <Tag>{chunk.kind}</Tag>
                        </Space>
                      }
                    >
                      <MiniMarkdown
                        className={styles.markdown}
                        text={full[chunk.chunkId] ?? chunk.text}
                      />
                      {full[chunk.chunkId] === undefined &&
                        chunk.text.length >= 400 && (
                          <Button
                            type="link"
                            onClick={() => void loadFull(chunk.chunkId)}
                          >
                            {text("expandChunk")}
                          </Button>
                        )}
                    </Card>
                  ))}
                  {preview?.chunks.length === 0 && <p>{text("emptyChunks")}</p>}
                </div>
              ),
            },
            {
              key: "raw",
              label: text("original"),
              children: (
                <div className={styles.stack}>
                  {raw?.state === "loading" && (
                    <p role="status">{text("loadingOriginal")}</p>
                  )}
                  {raw?.state === "iframe" && (
                    <iframe
                      className={styles.rawFrame}
                      src={raw.url}
                      title={text("original")}
                      sandbox=""
                    />
                  )}
                  {raw?.state === "markdown" && (
                    <MiniMarkdown
                      className={styles.markdown}
                      text={raw.text ?? ""}
                    />
                  )}
                  {raw?.state === "text" && (
                    <pre className={styles.pre}>{raw.text}</pre>
                  )}
                  {raw?.state === "unsupported" && (
                    <>
                      <p>{text("downloadOriginalHint")}</p>
                      <Button
                        href={`/api/admin/knowledge/documents/${docId}/file`}
                        download
                      >
                        {text("download")}
                      </Button>
                    </>
                  )}
                  {raw?.state === "missing" && (
                    <p>
                      {raw.message} · {text("originalMissing")}
                    </p>
                  )}
                  {raw?.state === "error" && <Feedback error={raw.message} />}
                </div>
              ),
            },
          ]}
        />
      </div>
    </Drawer>
  );
}
