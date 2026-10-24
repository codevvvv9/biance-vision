import { Drawer, Modal, overlayContainer } from "./ui/overlays";
import {
  App,
  AutoComplete,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useResource } from "./ui/resource";
import { Feedback } from "./ui/feedback";
import { useConfirmDiscard, useDirtyForm } from "./ui/forms";
import { useAdminText } from "./ui/text";
import {
  clearAiConfig,
  loadAiConfig,
  loadModels,
  loadPrompt,
  saveAiConfig,
  testAiConfig,
} from "./features/ai/configApi";
import type { AiProfileMasked } from "../types";
import styles from "./ui/admin.module.css";
interface ProfileForm {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  extraPrompt: string;
  dailyLimit?: number;
  allowedUsers: string[];
  enableTools: boolean;
}
const emptyProfile = (): ProfileForm => ({
  baseUrl: "",
  apiKey: "",
  model: "",
  extraPrompt: "",
  allowedUsers: [],
  enableTools: true,
});
const fromMasked = (
  p: AiProfileMasked & { enableTools?: boolean },
): ProfileForm => ({
  ...p,
  apiKey: p.apiKeyMasked,
  extraPrompt: p.extraPrompt ?? "",
  allowedUsers: p.allowedUsers ?? [],
  enableTools: p.enableTools ?? true,
});
export default function AiSettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: () => void;
}): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadAiConfig);
  const [profiles, setProfiles] = useState<Record<string, ProfileForm>>({
    default: emptyProfile(),
  });
  const [baseline, setBaseline] = useState("");
  const [current, setCurrent] = useState("default");
  const [models, setModels] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!resource.data) return;
    const next = Object.fromEntries(
      Object.entries(resource.data.profiles).map(([name, profile]) => [
        name,
        fromMasked(profile),
      ]),
    );
    if (!next.default) next.default = emptyProfile();
    setProfiles(next);
    setBaseline(JSON.stringify(next));
  }, [resource.data]);
  useEffect(() => {
    let active = true;
    setModels([]);
    setPrompt(null);
    if (!resource.data) return;
    void loadModels(current)
      .then((result) => {
        if (active) setModels(result.models);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [current, resource.data]);
  const form = profiles[current] ?? emptyProfile();
  const dirty = Boolean(baseline && baseline !== JSON.stringify(profiles));
  useDirtyForm(dirty);
  const confirmDiscard = useConfirmDiscard();
  const close = async () => {
    if (!busy && (await confirmDiscard(dirty))) onClose();
  };
  const field = <K extends keyof ProfileForm>(name: K, value: ProfileForm[K]) =>
    setProfiles((previous) => ({
      ...previous,
      [current]: { ...previous[current], [name]: value },
    }));
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveAiConfig(profiles);
      onSaved?.();
      onClose();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const remove = async (all = false) => {
    if (
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: all ? text("clearAiConfig") : text("deleteProfile"),
        content: text("profileFallback"),
        okText: text("confirm"),
        cancelText: text("cancel"),
        okButtonProps: { danger: true },
      }))
    )
      return;
    if (all) {
      setBusy(true);
      try {
        await clearAiConfig();
        onSaved?.();
        onClose();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    } else {
      setProfiles((previous) => {
        const next = { ...previous };
        delete next[current];
        return next;
      });
      setCurrent("default");
    }
  };
  return (
    <Drawer
      title={text("aiSettings")}
      open
      size={720}
      onClose={() => void close()}
      maskClosable={!busy}
      keyboard={!busy}
      loading={resource.loading}
      extra={
        <Button
          type="primary"
          loading={busy}
          disabled={!baseline}
          onClick={() => void save()}
        >
          {text("save")}
        </Button>
      }
    >
      <div className={styles.stack}>
        <Feedback error={error || resource.error} success={success} />
        <div className={styles.toolbar}>
          <Select
            aria-label={text("profile")}
            value={current}
            onChange={setCurrent}
            options={Object.keys(profiles).map((value) => ({
              value,
              label: value,
            }))}
            style={{ minWidth: 180 }}
          />
          <Space>
            <Button onClick={() => setNewName("")}>{text("newProfile")}</Button>
            <Button
              danger
              disabled={current === "default" || busy}
              onClick={() => void remove()}
            >
              {text("deleteProfile")}
            </Button>
          </Space>
        </div>
        <Typography.Paragraph type="secondary">
          {text("configHint")}
        </Typography.Paragraph>
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label="Base URL" htmlFor="admin-ai-base">
            <Input
              id="admin-ai-base"
              value={form.baseUrl}
              onChange={(event) => field("baseUrl", event.target.value)}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="API Key" htmlFor="admin-ai-key">
            <Input.Password
              id="admin-ai-key"
              value={form.apiKey}
              onChange={(event) => field("apiKey", event.target.value)}
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item label={text("model")}>
            <AutoComplete
              value={form.model}
              onChange={(value) => field("model", value)}
              options={models.map((value) => ({ value }))}
            />
          </Form.Item>
          <div className={styles.grid}>
            <Form.Item label="Temperature">
              <InputNumber
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(value) => field("temperature", value ?? undefined)}
              />
            </Form.Item>
            <Form.Item label={text("maxTokens")}>
              <InputNumber
                min={0}
                value={form.maxTokens}
                onChange={(value) => field("maxTokens", value ?? undefined)}
              />
            </Form.Item>
            <Form.Item label={text("dailyLimit")}>
              <InputNumber
                min={0}
                value={form.dailyLimit}
                onChange={(value) => field("dailyLimit", value ?? undefined)}
              />
            </Form.Item>
          </div>
          <Form.Item label={text("enableTools")}>
            <Switch
              checked={form.enableTools}
              onChange={(value) => field("enableTools", value)}
            />
          </Form.Item>
          {current !== "default" && (
            <Form.Item label={text("boundUsers")}>
              <Select
                mode="tags"
                tokenSeparators={[",", "，"]}
                value={form.allowedUsers}
                onChange={(value) => field("allowedUsers", value)}
                options={(resource.data?.users ?? []).map((user) => ({
                  value: user.username,
                  label: user.username,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item label={text("extraPrompt")}>
            <Input.TextArea
              rows={5}
              value={form.extraPrompt}
              onChange={(event) => field("extraPrompt", event.target.value)}
            />
          </Form.Item>
        </Form>
        <Space wrap>
          <Button
            loading={testing}
            disabled={busy}
            onClick={() => {
              setTesting(true);
              setError("");
              setSuccess("");
              void testAiConfig(current, form)
                .then((result) => {
                  if (!alive.current) return;
                  if (result.ok) setSuccess(text("connectionOk"));
                  else setError(result.message);
                })
                .catch((e) => alive.current && setError(e.message))
                .finally(() => alive.current && setTesting(false));
            }}
          >
            {text("testConnection")}
          </Button>
          <Button
            onClick={() => {
              if (prompt !== null) setPrompt(null);
              else
                void loadPrompt(current)
                  .then((result) => alive.current && setPrompt(result.prompt))
                  .catch((e) => alive.current && setError(e.message));
            }}
          >
            {text("effectivePrompt")}
          </Button>
          <Button danger disabled={busy} onClick={() => void remove(true)}>
            {text("clearAiConfig")}
          </Button>
        </Space>
        {prompt !== null && <pre className={styles.pre}>{prompt}</pre>}
      </div>
      <Modal
        title={text("newProfile")}
        open={newName !== null}
        onCancel={() => setNewName(null)}
        okText={text("create")}
        onOk={() => {
          const name = newName?.trim() ?? "";
          if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name) || profiles[name]) {
            setError(text("invalidProfile"));
            return;
          }
          setProfiles((previous) => ({ ...previous, [name]: emptyProfile() }));
          setCurrent(name);
          setNewName(null);
        }}
      >
        <Input
          autoFocus
          aria-label={text("profileName")}
          value={newName ?? ""}
          onChange={(event) => setNewName(event.target.value)}
        />
      </Modal>
    </Drawer>
  );
}
