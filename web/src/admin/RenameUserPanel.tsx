import { useState } from "react";
import { App, Button, Form, Input } from "antd";
import { renameUser } from "./features/panel/api";
import { Feedback } from "./ui/feedback";
import { Modal } from "./ui/overlays";
import { useAdminText } from "./ui/text";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

/** 用户改名：输入新用户名 → 服务端单事务迁移全部关联 → 展示迁移摘要 */
export function RenameUserPanel({
  username,
  onClose,
  onRenamed,
}: {
  username: string;
  onClose: () => void;
  onRenamed: () => void;
}): JSX.Element {
  const text = useAdminText(),
    { modal } = App.useApp();
  const [next, setNext] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState<{ to: string; rows: number } | null>(null);
  const valid = USERNAME_RE.test(next) && next !== username;
  const submit = async () => {
    if (!valid || busy) return;
    const confirmed = await modal.confirm({
      title: text("renameTitle"),
      content: text("renameImpact", { from: username, to: next }),
      okText: text("confirm"),
      cancelText: text("cancel"),
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const r = await renameUser(username, next);
      const rows = Object.values(r.migrated).reduce((sum, n) => sum + n, 0);
      setDone({ to: r.to, rows });
      onRenamed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${username} · ${text("renameTitle")}`}
      footer={null}
      onCancel={() => !busy && onClose()}
      closable={!busy}
      maskClosable={!busy}
    >
      <Feedback error={error} />
      {done ? (
        <div className="rename-done">
          <p>{text("renameDone", { from: username, to: done.to, rows: done.rows })}</p>
          <Button type="primary" onClick={onClose}>
            {text("close")}
          </Button>
        </div>
      ) : (
        <Form layout="vertical" onFinish={() => void submit()}>
          <p>{text("renameHint")}</p>
          <Form.Item
            label={text("renameNewName")}
            htmlFor="rename-next"
            validateStatus={next && !valid ? "error" : undefined}
            help={next && !valid ? text("renameInvalid") : undefined}
          >
            <Input
              id="rename-next"
              autoComplete="off"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              onPressEnter={() => void submit()}
              disabled={busy}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} disabled={!valid}>
            {text("renameTitle")}
          </Button>
        </Form>
      )}
    </Modal>
  );
}
