import { useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";
import AiSettingsModal from "./AiSettingsModal";
import {
  loadProfiles,
  provisionUser,
  type Delivery,
} from "./features/panel/api";
import { useResource } from "./ui/resource";
import { Feedback } from "./ui/feedback";
import { useAdminText } from "./ui/text";
import { useDirtyForm, useConfirmDiscard } from "./ui/forms";
import { Modal } from "./ui/overlays";
export function ProvisionUserPanel({
  onCreated,
}: {
  onCreated: () => void;
}): JSX.Element {
  const text = useAdminText(),
    confirmDiscard = useConfirmDiscard();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)}>
        {text("provisionUser")}
      </Button>
      {open && (
        <ProvisionDialog
          onCreated={onCreated}
          onClose={() => setOpen(false)}
          confirmDiscard={confirmDiscard}
        />
      )}
    </>
  );
}
function ProvisionDialog({
  onCreated,
  onClose,
  confirmDiscard,
}: {
  onCreated: () => void;
  onClose: () => void;
  confirmDiscard: (dirty?: boolean) => Promise<boolean>;
}): JSX.Element {
  const text = useAdminText(),
    profiles = useResource(loadProfiles);
  const [username, setUsername] = useState(""),
    [profile, setProfile] = useState("default");
  const [total, setTotal] = useState<number | null>(10),
    [daily, setDaily] = useState<number | null>(10),
    [minute, setMinute] = useState<number | null>(6);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [delivery, setDelivery] = useState<Delivery | null>(null),
    [aiOpen, setAiOpen] = useState(false),
    [copied, setCopied] = useState(false);
  const dirty =
    !delivery &&
    (username !== "" ||
      profile !== "default" ||
      total !== 10 ||
      daily !== 10 ||
      minute !== 6);
  useDirtyForm(dirty || Boolean(delivery));
  // Credentials exist only in this mounted dialog. No URL, logging or storage writes.
  const close = async () => {
    if (!busy && (await confirmDiscard(dirty || Boolean(delivery)))) onClose();
  };
  const create = async () => {
    if (busy || total == null || minute == null) return;
    setBusy(true);
    setError("");
    try {
      const result = await provisionUser({
        ...(username.trim() ? { username: username.trim() } : {}),
        profileName: profile,
        totalLimit: total,
        dailyLimit: daily,
        requestsPerMinute: minute,
      });
      setDelivery(result);
      setCopied(false);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!delivery) return;
    try {
      await navigator.clipboard.writeText(
        `Biance Vision\n${text("loginEntry")}: ${delivery.publicOrigin ?? ""}${delivery.loginPath}\n${text("username")}: ${delivery.username}\n${text("password")}: ${delivery.password}\n${text("totalLimit")}: ${delivery.access.totalLimit}\n${text("gettingStarted")}: ${delivery.publicOrigin ?? ""}/zh/guides/getting-started`,
      );
      setCopied(true);
    } catch {
      setError(text("copyCredentialsFailed"));
    }
  };
  const selected = profiles.data?.profiles[profile];
  return (
    <Modal
      open
      title={text("provisionUser")}
      footer={null}
      onCancel={() => void close()}
      closable={!busy}
      maskClosable={!busy}
      width={680}
    >
      <Feedback error={error || profiles.error} />
      {delivery ? (
        <div role="status">
          <Typography.Paragraph>{text("deliveryHint")}</Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label={text("username")} htmlFor="delivery-username">
              <Input
                id="delivery-username"
                readOnly
                value={delivery.username}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Form.Item>
            <Form.Item
              label={text("randomPassword")}
              htmlFor="delivery-password"
            >
              <Input.Password
                id="delivery-password"
                readOnly
                autoComplete="off"
                value={delivery.password}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Form.Item>
          </Form>
          <Space wrap>
            <Button onClick={() => void copy()}>
              {text(copied ? "copied" : "copyCredentials")}
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setDelivery(null);
                onClose();
              }}
            >
              {text("clearCredentials")}
            </Button>
          </Space>
        </div>
      ) : (
        <Form layout="vertical" onFinish={() => void create()}>
          <p>{text("provisionHint")}</p>
          <Form.Item
            label={text("optionalUsername")}
            htmlFor="provision-username"
          >
            <Input
              id="provision-username"
              maxLength={32}
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Form.Item>
          <Form.Item label={text("aiProfile")}>
            <Select
              aria-label={text("aiProfile")}
              value={profile}
              onChange={setProfile}
              options={Object.entries(profiles.data?.profiles ?? {}).map(
                ([value, p]) => ({ value, label: `${value} · ${p.model}` }),
              )}
            />
          </Form.Item>
          <Form.Item label={text("totalLimit")}>
            <InputNumber
              aria-label={text("totalLimit")}
              min={1}
              max={100000}
              value={total}
              onChange={setTotal}
            />
          </Form.Item>
          <Form.Item label={text("dailyLimit")}>
            <InputNumber
              aria-label={text("dailyLimit")}
              min={1}
              max={100000}
              value={daily}
              onChange={setDaily}
            />
          </Form.Item>
          <Form.Item label={text("requestsPerMinute")}>
            <InputNumber
              aria-label={text("requestsPerMinute")}
              min={1}
              max={60}
              value={minute}
              onChange={setMinute}
            />
          </Form.Item>
          <p>{text("quotaCountingHint")}</p>
          {selected && (
            <p>
              {selected.model} · {selected.maxTokens ?? "—"} tokens
            </p>
          )}
          <Space wrap>
            <Button onClick={() => setAiOpen(true)}>
              {text("editAiProfile")}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={
                !selected?.apiKeyMasked ||
                !Number.isInteger(total) ||
                Number(total) < 1 ||
                !Number.isInteger(minute) ||
                Number(minute) < 1
              }
            >
              {text("saveAndDeliver")}
            </Button>
          </Space>
        </Form>
      )}
      {aiOpen && (
        <AiSettingsModal
          onClose={() => {
            setAiOpen(false);
            void profiles.reload();
          }}
          onSaved={() => void profiles.reload()}
        />
      )}
    </Modal>
  );
}
