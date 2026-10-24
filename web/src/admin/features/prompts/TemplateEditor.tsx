import { Drawer } from "../../ui/overlays";
import { useState } from "react";
import { Button, Form, Input, Select } from "antd";
import { TASK_SCENES } from "biance-vision-brooks";
import { saveTemplate, type TemplateDto } from "./api";
import { useConfirmDiscard, useDirtyForm } from "../../ui/forms";
import { useAdminText } from "../../ui/text";
import { Feedback } from "../../ui/feedback";
import styles from "../../ui/admin.module.css";
/** Same supported template names as the existing registry, including translation. */
const names = [
  "intent-classifier",
  "counter-reviewer",
  "news-attribution",
  "concept-teaching",
  "query-rewrite",
  "synthesis-writer",
  "memory-extraction",
  "translate",
];
export function TemplateEditor({
  template,
  onClose,
  onSaved,
}: {
  template?: TemplateDto;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const initial = {
    name: template?.name ?? names[0],
    scene: template?.scene ?? "",
    content: template?.content ?? "",
    note: template?.note ?? "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      await saveTemplate(template?.id, form);
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
      title={
        template
          ? `${text("edit")} · ${template.name} v${template.version}`
          : text("newDraft")
      }
      open
      size={800}
      onClose={() => void close()}
      keyboard={!busy}
      maskClosable={!busy}
      extra={
        <Button
          type="primary"
          loading={busy}
          disabled={!form.content.trim()}
          onClick={() => void save()}
        >
          {text("save")}
        </Button>
      }
    >
      <Feedback error={error} />
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label={text("template")}>
          <Select
            aria-label={text("template")}
            disabled={Boolean(template)}
            value={form.name}
            onChange={(name) => setForm((previous) => ({ ...previous, name }))}
            options={names.map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item label={text("scope")}>
          <Select
            aria-label={text("scope")}
            disabled={Boolean(template)}
            value={form.scene}
            onChange={(scene) =>
              setForm((previous) => ({ ...previous, scene }))
            }
            options={[
              { value: "", label: text("global") },
              ...TASK_SCENES.map((value) => ({ value, label: value })),
            ]}
          />
        </Form.Item>
        <Form.Item label={text("content")}>
          <Input.TextArea
            aria-label={text("content")}
            className={styles.mono}
            spellCheck={false}
            rows={20}
            maxLength={20000}
            showCount
            value={form.content}
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                content: event.target.value,
              }))
            }
          />
        </Form.Item>
        {!template && (
          <Form.Item label={text("note")}>
            <Input
              aria-label={text("note")}
              value={form.note}
              onChange={(event) =>
                setForm((previous) => ({
                  ...previous,
                  note: event.target.value,
                }))
              }
            />
          </Form.Item>
        )}
      </Form>
    </Drawer>
  );
}
