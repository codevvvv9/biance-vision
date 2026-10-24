import { useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { AgentCapabilities } from "biance-vision-brooks";
import { useAdminText } from "../../ui/text";
import { Feedback } from "../../ui/feedback";
import { useDirtyForm } from "../../ui/forms";
import { saveCapabilities, testCapabilities, type CapabilityTest } from "./api";
import styles from "../../ui/admin.module.css";
export function Capabilities({
  initial,
  onSaved,
  source,
}: {
  initial: AgentCapabilities;
  onSaved: () => void;
  source: string;
}): JSX.Element {
  const text = useAdminText();
  const [caps, setCaps] = useState(initial);
  const [domains, setDomains] = useState(
    (initial.search.allowedDomains ?? []).join(","),
  );
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<CapabilityTest | null>(null);
  useDirtyForm(baseline !== JSON.stringify(caps));
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveCapabilities(caps);
      setBaseline(JSON.stringify(caps));
      setSuccess(text("operationDone"));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (key: keyof AgentCapabilities, field: string, value: unknown) =>
    setCaps((previous) => ({
      ...previous,
      [key]: { ...previous[key], [field]: value },
    }));
  return (
    <div className={styles.stack}>
      <Feedback error={error} success={success} />
      <Typography.Text type="secondary">
        {text("capSource", { source })}
      </Typography.Text>
      <div className={styles.grid}>
        {(["chat", "embedding", "rerank", "vision", "search"] as const).map(
          (key) => {
            const cap = caps[key];
            return (
              <Card
                key={key}
                title={text(key)}
                extra={
                  <Switch
                    aria-label={text(key)}
                    checked={cap.enabled}
                    onChange={(value) => set(key, "enabled", value)}
                  />
                }
              >
                <Form layout="vertical" requiredMark={false}>
                  <Form.Item label={text("baseUrl")} htmlFor={`${key}-base`}>
                    <Input
                      id={`${key}-base`}
                      value={cap.baseUrl ?? ""}
                      onChange={(event) =>
                        set(key, "baseUrl", event.target.value)
                      }
                    />
                  </Form.Item>
                  <Form.Item label={text("model")} htmlFor={`${key}-model`}>
                    <Input
                      id={`${key}-model`}
                      value={cap.model ?? ""}
                      onChange={(event) =>
                        set(key, "model", event.target.value)
                      }
                    />
                  </Form.Item>
                  <Form.Item
                    label={text("secretRef")}
                    htmlFor={`${key}-secret`}
                  >
                    <Input
                      id={`${key}-secret`}
                      value={cap.secretRef ?? ""}
                      autoComplete="off"
                      onChange={(event) =>
                        set(key, "secretRef", event.target.value)
                      }
                    />
                  </Form.Item>
                  {key === "embedding" && (
                    <Form.Item label={text("dimensions")}>
                      <InputNumber
                        aria-label={text("dimensions")}
                        min={1}
                        value={caps.embedding.dims ?? 1536}
                        onChange={(value) =>
                          set(key, "dims", value ?? undefined)
                        }
                      />
                    </Form.Item>
                  )}
                  {key === "search" && (
                    <>
                      <Form.Item label={text("allowedDomains")}>
                        <Input
                          aria-label={text("allowedDomains")}
                          value={domains}
                          onChange={(event) => {
                            setDomains(event.target.value);
                            const values = event.target.value
                              .split(/[,，]/)
                              .map((value) => value.trim())
                              .filter(Boolean);
                            set(
                              key,
                              "allowedDomains",
                              values.length ? values : undefined,
                            );
                          }}
                        />
                      </Form.Item>
                      {(["timeoutMs", "maxBytes", "maxResults"] as const).map(
                        (field, index) => (
                          <Form.Item
                            key={field}
                            label={text(
                              ["timeout", "maxBytes", "maxResults"][index],
                            )}
                          >
                            <InputNumber
                              min={1}
                              value={caps.search[field]}
                              onChange={(value) =>
                                set(key, field, value ?? undefined)
                              }
                            />
                          </Form.Item>
                        ),
                      )}
                    </>
                  )}
                </Form>
              </Card>
            );
          },
        )}
      </div>
      <Card title={text("knowledgeEnhance")}>
        <Form layout="vertical">
          <Form.Item label={text("knowledgeEnhance")}>
            <Switch
              checked={caps.knowledge?.enhance.enabled ?? false}
              onChange={(enabled) =>
                setCaps((previous) => ({
                  ...previous,
                  knowledge: {
                    enhance: {
                      keywordsPerChunk: 4,
                      questionsPerChunk: 2,
                      ...previous.knowledge?.enhance,
                      enabled,
                    },
                  },
                }))
              }
            />
          </Form.Item>
          {(["keywordsPerChunk", "questionsPerChunk"] as const).map((field) => (
            <Form.Item key={field} label={text(field)}>
              <InputNumber
                min={1}
                max={field === "keywordsPerChunk" ? 8 : 4}
                value={
                  caps.knowledge?.enhance[field] ??
                  (field === "keywordsPerChunk" ? 4 : 2)
                }
                onChange={(value) =>
                  setCaps((previous) => ({
                    ...previous,
                    knowledge: {
                      enhance: {
                        enabled: false,
                        keywordsPerChunk: 4,
                        questionsPerChunk: 2,
                        ...previous.knowledge?.enhance,
                        [field]: value ?? 1,
                      },
                    },
                  }))
                }
              />
            </Form.Item>
          ))}
        </Form>
      </Card>
      <Space wrap>
        <Button type="primary" loading={busy} onClick={() => void save()}>
          {text("save")}
        </Button>
        <Button
          loading={testing}
          onClick={() => {
            setTesting(true);
            setError("");
            void testCapabilities(caps)
              .then(setTest)
              .catch((e) => setError(e.message))
              .finally(() => setTesting(false));
          }}
        >
          {text("testCapabilities")}
        </Button>
      </Space>
      <Typography.Text type="secondary">{text("secretHint")}</Typography.Text>
      {test && (
        <Table
          pagination={false}
          rowKey="key"
          dataSource={Object.entries(test.results).map(([key, value]) => ({
            key,
            ...value,
          }))}
          scroll={{ x: 600 }}
          columns={[
            {
              title: text("capabilities"),
              dataIndex: "key",
              render: (key) => text(key),
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => (
                <Tag
                  color={
                    status === "ok"
                      ? "success"
                      : status === "failed"
                        ? "error"
                        : undefined
                  }
                >
                  {status}
                </Tag>
              ),
            },
            { title: text("result"), dataIndex: "detail" },
            {
              title: text("latency"),
              dataIndex: "latencyMs",
              render: (ms) => (ms == null ? "—" : `${ms}ms`),
            },
          ]}
        />
      )}
    </div>
  );
}
