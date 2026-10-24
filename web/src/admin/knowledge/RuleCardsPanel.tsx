import { Drawer, overlayContainer } from "../ui/overlays";
import { useState } from "react";
import { App, Button, Card, Form, Input, Space, Table, Tag } from "antd";
import {
  loadCards,
  draftCard,
  saveCard,
  cardAction,
  type RuleCard,
} from "../features/knowledge/contentApi";
import { useResource } from "../ui/resource";
import { useConfirmDiscard, useDirtyForm } from "../ui/forms";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
import styles from "../ui/admin.module.css";
function Editor({
  card,
  onClose,
  onSaved,
}: {
  card: RuleCard;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const initial = {
    definition: card.content.definition ?? "",
    conditions: (card.content.conditions ?? []).join("\n"),
    context: card.content.context ?? "",
    invalidation: card.content.invalidation ?? "",
    confusable: (card.content.confusable ?? []).join("\n"),
    counterExamples: (card.content.counterExamples ?? []).join("\n"),
    ruleId: card.content.ruleId ?? "",
    sourceNote: card.content.sourceNote ?? "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useDirtyForm(dirty);
  const discard = useConfirmDiscard();
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose();
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveCard(card.id, {
        ...card.content,
        definition: form.definition,
        conditions: form.conditions
          .split(/[；;\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
        context: form.context,
        invalidation: form.invalidation,
        confusable: form.confusable
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        counterExamples: form.counterExamples
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        ruleId: form.ruleId,
        sourceNote: form.sourceNote,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      title={`${text("edit")} · ${card.concept}`}
      size={700}
      onClose={() => void close()}
      maskClosable={!busy}
      keyboard={!busy}
      extra={
        <Button type="primary" loading={busy} onClick={() => void save()}>
          {text("save")}
        </Button>
      }
    >
      <Feedback error={error} />
      <Form layout="vertical">
        {(
          [
            "definition",
            "conditions",
            "context",
            "invalidation",
            "confusable",
            "counterExamples",
            "ruleId",
            "sourceNote",
          ] as const
        ).map((key) => (
          <Form.Item key={key} label={text(key)}>
            <Input.TextArea
              aria-label={text(key)}
              rows={key === "definition" ? 5 : 3}
              value={form[key]}
              onChange={(event) =>
                setForm((previous) => ({
                  ...previous,
                  [key]: event.target.value,
                }))
              }
            />
          </Form.Item>
        ))}
      </Form>
    </Drawer>
  );
}
export default function RuleCardsPanel({
  onError,
}: {
  onError: (message: string) => void;
}): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadCards);
  const [concept, setConcept] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<RuleCard | null>(null);
  useDirtyForm(Boolean(concept));
  const draft = async () => {
    if (busy || !concept.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await draftCard(concept);
      setConcept("");
      await resource.reload();
      setEditing(result.card);
    } catch (e) {
      setError((e as Error).message);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (card: RuleCard, action: "publish" | "delete") => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text(action)} · ${card.concept}`,
        content: text("ruleReviewHint"),
        okText: text("confirm"),
        cancelText: text("cancel"),
        okButtonProps: { danger: action === "delete" },
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await cardAction(card.id, action);
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={error || resource.error} />
        <div className={styles.toolbar}>
          <Input
            aria-label={text("concept")}
            placeholder={text("concept")}
            value={concept}
            onChange={(event) => setConcept(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button
            type="primary"
            loading={busy}
            disabled={!concept.trim()}
            onClick={() => void draft()}
          >
            {text("newDraft")}
          </Button>
        </div>
        <Table<RuleCard>
          rowKey="id"
          dataSource={resource.data?.cards ?? []}
          loading={resource.loading || busy}
          scroll={{ x: 750 }}
          columns={[
            { title: text("concept"), dataIndex: "concept" },
            {
              title: text("definition"),
              render: (_, card) => card.content.definition || "—",
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => <Tag>{text(status)}</Tag>,
            },
            {
              title: text("version"),
              dataIndex: "version",
              render: (version) => `v${version}`,
            },
            {
              title: text("actions"),
              render: (_, card) =>
                card.status === "draft" && (
                  <Space wrap>
                    <Button size="small" onClick={() => setEditing(card)}>
                      {text("edit")}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => void act(card, "publish")}
                    >
                      {text("publish")}
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() => void act(card, "delete")}
                    >
                      {text("delete")}
                    </Button>
                  </Space>
                ),
            },
          ]}
        />
        {editing && (
          <Editor
            key={editing.id}
            card={editing}
            onClose={() => setEditing(null)}
            onSaved={() => void resource.reload()}
          />
        )}
      </div>
    </Card>
  );
}
