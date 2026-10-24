import { Modal } from "../../ui/overlays";
import { useState } from "react";
import { Form, Input, Select } from "antd";
import { createDataset } from "./api";
import { useAdminText } from "../../ui/text";
import { useConfirmDiscard, useDirtyForm } from "../../ui/forms";
import { Feedback } from "../../ui/feedback";
import styles from "../../ui/admin.module.css";
export function CreateDataset({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const [name, setName] = useState(""),
    [items, setItems] = useState("[]"),
    [kind, setKind] = useState("rag");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = Boolean(name || items !== "[]" || kind !== "rag");
  useDirtyForm(dirty);
  const discard = useConfirmDiscard();
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose();
  };
  const save = async () => {
    if (busy) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(items);
      if (!Array.isArray(parsed)) {
        setError(text("datasetArrayRequired"));
        return;
      }
    } catch {
      setError(text("invalidJson"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createDataset(kind, name, parsed);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={text("newDataset")}
      open
      width={720}
      onCancel={() => void close()}
      maskClosable={!busy}
      keyboard={!busy}
      onOk={() => void save()}
      confirmLoading={busy}
      okText={text("create")}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <Feedback error={error} />
      <Form layout="vertical">
        <Form.Item label={text("name")}>
          <Input
            aria-label={text("name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={text("kind")}>
          <Select
            aria-label={text("kind")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "rag", label: "RAG" },
              { value: "structure", label: text("structureReplay") },
            ]}
          />
        </Form.Item>
        <Form.Item label={text("items")}>
          <Input.TextArea
            aria-label={text("items")}
            className={styles.mono}
            rows={12}
            value={items}
            onChange={(event) => setItems(event.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
