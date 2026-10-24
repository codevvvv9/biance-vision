import { Modal } from "../../ui/overlays";
import { useState } from "react";
import { Form, Input, Select, Typography } from "antd";
import { trainModel } from "./api";
import { useAdminText } from "../../ui/text";
import { useConfirmDiscard, useDirtyForm } from "../../ui/forms";
import { Feedback } from "../../ui/feedback";
export function TrainModel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const [version, setVersion] = useState(""),
    [horizon, setHorizon] = useState("10m");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = Boolean(version || horizon !== "10m");
  useDirtyForm(dirty);
  const discard = useConfirmDiscard();
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose();
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await trainModel(version, horizon);
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
      title={text("trainModel")}
      open
      onCancel={() => void close()}
      onOk={() => void submit()}
      maskClosable={!busy}
      keyboard={!busy}
      confirmLoading={busy}
      okText={text("confirm")}
      okButtonProps={{ disabled: !version.trim() }}
    >
      <Feedback error={error} />
      <Typography.Paragraph>{text("trainImpact")}</Typography.Paragraph>
      <Form layout="vertical">
        <Form.Item label={text("versionLabel")}>
          <Input
            aria-label={text("versionLabel")}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={text("horizon")}>
          <Select
            aria-label={text("horizon")}
            value={horizon}
            onChange={setHorizon}
            options={["10m", "30m", "1h", "1d", "1w"].map((value) => ({
              value,
              label: value === "1w" ? `1w · ${text("researchMode")}` : value,
            }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
