import { useState } from "react";
import { Button, Card, Form, Input } from "antd";
import { useResource } from "../../ui/resource";
import { Feedback, Loading } from "../../ui/feedback";
import { useDirtyForm } from "../../ui/forms";
import { useAdminText } from "../../ui/text";
import {
  loadDisclaimers,
  loadInputConfig,
  saveDisclaimers,
  saveInputConfig,
  type DisclaimerConfig,
} from "./api";
import styles from "../../ui/admin.module.css";
function DisclaimerForm({
  initial,
}: {
  initial: DisclaimerConfig;
}): JSX.Element {
  const text = useAdminText();
  const [value, setValue] = useState(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false);
  useDirtyForm(JSON.stringify(value) !== baseline);
  return (
    <Card>
      <Feedback error={error} success={success} />
      <Form layout="vertical">
        {(["common", "perp", "event"] as const).map((key) => (
          <Form.Item key={key} label={text(`${key}Disclaimer`)}>
            <Input.TextArea
              aria-label={text(`${key}Disclaimer`)}
              rows={4}
              value={value[key]}
              onChange={(event) =>
                setValue((previous) => ({
                  ...previous,
                  [key]: event.target.value,
                }))
              }
            />
          </Form.Item>
        ))}
        <Button
          type="primary"
          loading={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setError("");
            void saveDisclaimers(value)
              .then(() => {
                setBaseline(JSON.stringify(value));
                setSuccess(text("operationDone"));
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {text("save")}
        </Button>
      </Form>
    </Card>
  );
}
export function Disclaimers(): JSX.Element {
  const resource = useResource(loadDisclaimers);
  return (
    <>
      <Feedback error={resource.error} />
      {resource.data ? (
        <DisclaimerForm initial={resource.data.disclaimers} />
      ) : (
        <Loading />
      )}
    </>
  );
}
function InputConfigForm({ initial }: { initial: unknown }): JSX.Element {
  const text = useAdminText();
  const [value, setValue] = useState(
    JSON.stringify(initial ?? { scenes: {} }, null, 2),
  );
  const [baseline, setBaseline] = useState(value);
  const [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false);
  useDirtyForm(value !== baseline);
  const save = async () => {
    if (busy) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setError(text("invalidJson"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveInputConfig(parsed);
      setBaseline(value);
      setSuccess(text("operationDone"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={error} success={success} />
        <Input.TextArea
          aria-label={text("inputConfig")}
          className={styles.mono}
          rows={20}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div>
          <Button type="primary" loading={busy} onClick={() => void save()}>
            {text("save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
export function InputConfig(): JSX.Element {
  const resource = useResource(loadInputConfig);
  return (
    <>
      <Feedback error={resource.error} />
      {resource.data ? (
        <InputConfigForm initial={resource.data.chatInput} />
      ) : (
        <Loading />
      )}
    </>
  );
}
