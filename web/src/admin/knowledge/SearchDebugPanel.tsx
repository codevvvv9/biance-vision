import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Segmented,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import type { SearchDebugResult } from "biance-vision-brooks";
import { searchKnowledge } from "../features/knowledge/contentApi";
import MiniMarkdown from "../../components/MiniMarkdown";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
import styles from "../ui/admin.module.css";
export default function SearchDebugPanel({
  onError,
}: {
  onError: (message: string) => void;
}): JSX.Element {
  const text = useAdminText();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"support" | "counter">("support");
  const [busy, setBusy] = useState(false);
  const [debug, setDebug] = useState<SearchDebugResult | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setDebug(null);
    setBusy(false);
    return () => {
      sequence.current++;
    };
  }, [query, mode]);
  const run = async () => {
    if (busy || !query.trim()) return;
    const current = sequence.current;
    setBusy(true);
    setError("");
    try {
      const result = await searchKnowledge(query, mode);
      if (current === sequence.current) setDebug(result);
    } catch (e) {
      if (current === sequence.current) {
        setError((e as Error).message);
        onError((e as Error).message);
      }
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  };
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={error} />
        <div className={styles.toolbar}>
          <Input.Search
            aria-label={text("query")}
            placeholder={text("query")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void run()}
            loading={busy}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as typeof mode)}
            options={[
              { value: "support", label: text("supportEvidence") },
              { value: "counter", label: text("counterEvidence") },
            ]}
          />
        </div>
        {debug && (
          <>
            <div className={styles.grid}>
              {[
                ["variants", debug.variants.length],
                ["termHits", debug.termHits.length],
                ["vectorHits", debug.vectorHits.length],
                ["fused", debug.fused.length],
                ["reranked", debug.reranked.length],
                ["hits", debug.hits.length],
              ].map(([key, value]) => (
                <Statistic
                  key={key}
                  title={text(String(key))}
                  value={Number(value)}
                />
              ))}
            </div>
            {debug.variants.length > 0 && (
              <Typography.Paragraph type="secondary">
                {debug.variants.join(" · ")}
              </Typography.Paragraph>
            )}
            {debug.hits.map((hit, index) => (
              <Card
                key={hit.chunkId}
                size="small"
                title={`${index + 1}. ${hit.docTitle}`}
              >
                <Space wrap>
                  {hit.pageNo != null && (
                    <Tag>{text("pageNumber", { page: hit.pageNo })}</Tag>
                  )}
                  {hit.figureId && (
                    <Tag>{text("figureNumber", { figure: hit.figureId })}</Tag>
                  )}
                  <Tag>{hit.kind}</Tag>
                  <Tag>{text(`tier_${hit.sourceTier}`)}</Tag>
                </Space>
                <MiniMarkdown className={styles.markdown} text={hit.snippet} />
              </Card>
            ))}
            {debug.hits.length === 0 && (
              <Alert type="info" title={text("noSearchHits")} />
            )}
            {[...debug.adjacencyNotes, ...debug.notes].map((note, index) => (
              <Typography.Paragraph type="secondary" key={index}>
                {note}
              </Typography.Paragraph>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}
