import { Drawer } from "../../ui/overlays";
import { useState } from "react";
import { Button, Form, Input, Typography } from "antd";
import type { AgentVersion } from "biance-vision-brooks";
import { DEFAULT_CONFIG } from "./model";
import { saveAgentDraft } from "./api";
import { useAdminText } from "../../ui/text";
import { useConfirmDiscard, useDirtyForm } from "../../ui/forms";
import { Feedback } from "../../ui/feedback";
import styles from "../../ui/admin.module.css";
export function VersionEditor({
  version,
  current,
  onClose,
  onSaved,
}: {
  version?: AgentVersion;
  current?: AgentVersion;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const initial = JSON.stringify(version?.config ?? DEFAULT_CONFIG, null, 2);
  const [config, setConfig] = useState(initial);
  const [label, setLabel] = useState(version?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = config !== initial || label !== (version?.label ?? "");
  useDirtyForm(dirty);
  const discard = useConfirmDiscard();
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose();
  };
  const save = async () => {
    if (busy) return;
    setError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(config);
    } catch {
      setError(text("invalidJson"));
      return;
    }
    setBusy(true);
    try {
      await saveAgentDraft(version?.id, label, parsed);
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
      title={version ? `${text("edit")} · ${version.label}` : text("newDraft")}
      size={880}
      onClose={() => void close()}
      keyboard={!busy}
      maskClosable={!busy}
      extra={
        <Button
          type="primary"
          loading={busy}
          disabled={!label.trim()}
          onClick={() => void save()}
        >
          {text("save")}
        </Button>
      }
    >
      <Feedback error={error} />
      <Form layout="vertical">
        <Form.Item label={text("versionLabel")}>
          <Input
            aria-label={text("versionLabel")}
            disabled={Boolean(version)}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={text("configuration")}>
          <Input.TextArea
            aria-label={text("configuration")}
            className={styles.mono}
            spellCheck={false}
            rows={20}
            value={config}
            onChange={(event) => setConfig(event.target.value)}
          />
        </Form.Item>
      </Form>
      {current && (
        <details>
          <summary>{text("compare")}</summary>
          <Typography.Paragraph type="secondary">
            {current.label}
          </Typography.Paragraph>
          <pre className={styles.pre}>
            {JSON.stringify(current.config, null, 2)}
          </pre>
        </details>
      )}
    </Drawer>
  );
}
