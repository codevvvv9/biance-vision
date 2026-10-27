import { useCallback, useState } from "react";
import { App, Button, Form, Input, InputNumber, Space } from "antd";
import {
  loadAccess,
  saveAccess,
  resetCredentials,
  type Access,
} from "./features/panel/api";
import { useResource } from "./ui/resource";
import { useDirtyForm, useConfirmDiscard } from "./ui/forms";
import { Feedback, Loading } from "./ui/feedback";
import { Modal, overlayContainer } from "./ui/overlays";
import { useAdminText } from "./ui/text";
import type { MembershipStatus } from "biance-vision-brooks";
import { useMemberLabel } from "./MembershipForms";
export function UserAccessPanel({
  username,
  onClose,
}: {
  username: string;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText(),
    load = useCallback(() => loadAccess(username), [username]),
    resource = useResource(load);
  return (
    <>
      {resource.data ? (
        <AccessDialog
          username={username}
          initial={resource.data.access}
          membership={resource.data.membership}
          onClose={onClose}
        />
      ) : (
        <Modal open title={username} footer={null} onCancel={onClose}>
          <Feedback error={resource.error} />
          {resource.loading && <Loading />}
        </Modal>
      )}
    </>
  );
}
function AccessDialog({
  username,
  initial,
  membership,
  onClose,
}: {
  username: string;
  initial: Access | null;
  membership?: MembershipStatus;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText(),
    L = useMemberLabel(),
    { modal } = App.useApp(),
    discard = useConfirmDiscard();
  const [access, setAccess] = useState(initial),
    [baseline, setBaseline] = useState(JSON.stringify(initial)),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [custom, setCustom] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const dirty = JSON.stringify(access) !== baseline;
  useDirtyForm(dirty || Boolean(password) || Boolean(custom));
  const close = async () => {
    if (!busy && (await discard(dirty || Boolean(password)))) onClose();
  };
  const save = async () => {
    if (!access || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await saveAccess(username, access);
      setAccess(r.access);
      setBaseline(JSON.stringify(r.access));
      setSuccess(text("quotaSaved"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // 统一入口：填了自定义密码按原文交付；留空保持原设计生成随机交付密码（两者都会使既有会话失效）
  const applyPassword = async () => {
    const pwd = custom.trim();
    if (busy || (pwd && (pwd.length < 4 || pwd.length > 64))) return;
    if (
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: pwd ? text("setCustomPassword") : text("resetPassword"),
        content: text("resetPasswordImpact", { username }),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    setError("");
    setPassword("");
    try {
      setPassword((await resetCredentials(username, pwd || undefined)).password);
      setCustom("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${username} · ${text("quotaCredentials")}`}
      footer={null}
      onCancel={() => void close()}
      closable={!busy}
      maskClosable={!busy}
    >
      <Feedback error={error} success={success} />
      {membership?.managed ? (
        <p>{L('membership')}: {membership.current?.name ?? L('expired')} · {L('usedToday')} {membership.usedToday} / {membership.current?.dailyLimit ?? '∞'}</p>
      ) : access ? (
        <Form layout="vertical" onFinish={() => void save()}>
          <p>
            {text("usedQuota", {
              used: access.used ?? 0,
              total: access.totalLimit,
              remaining: Math.max(0, access.totalLimit - (access.used ?? 0)),
            })}
          </p>
          <Form.Item label={text("totalLimit")}>
            <InputNumber
              aria-label={text("totalLimit")}
              min={0}
              max={100000}
              value={access.totalLimit}
              onChange={(value) =>
                setAccess({ ...access, totalLimit: value ?? 0 })
              }
            />
          </Form.Item>
          <Form.Item label={text("dailyLimit")}>
            <InputNumber
              aria-label={text("dailyLimit")}
              min={1}
              max={100000}
              value={access.dailyLimit}
              onChange={(value) => setAccess({ ...access, dailyLimit: value })}
            />
          </Form.Item>
          <Form.Item label={text("requestsPerMinute")}>
            <InputNumber
              aria-label={text("requestsPerMinute")}
              min={1}
              max={60}
              value={access.requestsPerMinute}
              onChange={(value) =>
                setAccess({ ...access, requestsPerMinute: value ?? 1 })
              }
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            {text("saveQuota")}
          </Button>
        </Form>
      ) : (
        <p>{text("legacyQuota")}</p>
      )}
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label={text("setCustomPassword")} htmlFor="custom-password" style={{ marginBottom: 8 }}>
          <Space.Compact style={{ width: "100%" }}>
            <Input.Password
              id="custom-password"
              aria-label={text("setCustomPassword")}
              autoComplete="new-password"
              placeholder={text("customPasswordPlaceholder")}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onPressEnter={() => void applyPassword()}
              disabled={busy}
            />
            <Button
              danger
              disabled={busy || (custom.trim().length > 0 && custom.trim().length < 4) || custom.trim().length > 64}
              onClick={() => void applyPassword()}
            >
              {custom.trim() ? text("setPasswordAction") : text("resetPassword")}
            </Button>
          </Space.Compact>
        </Form.Item>
      </Form>
      <Space wrap style={{ marginTop: 8 }}>
        {password && (
          <Button
            onClick={() => {
              setPassword("");
              onClose();
            }}
          >
            {text("clearCredentials")}
          </Button>
        )}
      </Space>
      {password && (
        <Form layout="vertical">
          <Form.Item label={text("randomPassword")} htmlFor="reset-password">
            <Input.Password
              id="reset-password"
              readOnly
              autoComplete="off"
              value={password}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
