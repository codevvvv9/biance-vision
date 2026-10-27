import { MemberUserPanel } from './MemberUserPanel'
import { useMemberLabel } from './MembershipForms'
import { useCallback, useState } from "react";
import {
  App,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { AdminUserRow, AuditRecord } from "../types";
import { fmtDateTime } from "../utils";
import {
  fetchAdminUsers,
  updateChatPolicy,
  cutOffUserChat,
  loadAudit,
} from "./features/panel/api";
import { ProvisionUserPanel } from "./ProvisionUserPanel";
import { RenameUserPanel } from "./RenameUserPanel";
import { UserAccessPanel } from "./UserAccessPanel";
import { WebsiteSettings } from "./WebsiteSettings";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { Feedback } from "./ui/feedback";
import { AdminViews } from "./ui/views";
import { overlayContainer } from "./ui/overlays";
import styles from "./ui/admin.module.css";
function DailyLimit({
  user,
  busy,
  onSave,
}: {
  user: AdminUserRow;
  busy: boolean;
  onSave: (dailyLimit: number | null) => void;
}): JSX.Element {
  const text = useAdminText(),
    [value, setValue] = useState(user.chatPolicy.dailyLimit);
  return (
    <Space.Compact>
      <InputNumber
        style={{ width: 100 }}
        aria-label={`${user.username} ${text("dailyLimit")}`}
        min={1}
        precision={0}
        value={value}
        placeholder={text("unlimited")}
        onChange={setValue}
        disabled={busy}
      />
      <Button
        disabled={busy || value === user.chatPolicy.dailyLimit}
        onClick={() => onSave(value)}
      >
        {text("save")}
      </Button>
    </Space.Compact>
  );
}
function Users(): JSX.Element {
  const L = useMemberLabel(), [memberUser, setMemberUser] = useState<string | null>(null);
  const text = useAdminText(),
    resource = useResource(fetchAdminUsers),
    { modal } = App.useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [accessUser, setAccessUser] = useState<string | null>(null),
    [renameTarget, setRenameUser] = useState<string | null>(null);
  const run = async (op: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await op();
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cutoff = async (user: AdminUserRow) => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: text("cutoff"),
        content: text("cutoffImpact", { username: user.username }),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    await run(async () => {
      const r = await cutOffUserChat(user.username);
      setSuccess(
        text("cutoffDone", { count: r.cancelledRuns.length }) +
          (r.cancelDeferred ? ` ${text("cancelDeferred")}` : ""),
      );
    });
  };
  return (
    <div className={styles.stack}>
      <Feedback error={error || resource.error} success={success} />
      <Card>
        <div className={styles.toolbar}>
          <p>{text("userPolicyHint")}</p>
          <Space wrap>
            <Button onClick={() => void resource.reload()}>
              {text("refresh")}
            </Button>
            <ProvisionUserPanel onCreated={() => void resource.reload()} />
          </Space>
        </div>
        <Table<AdminUserRow>
          rowKey="username"
          loading={resource.loading}
          dataSource={resource.data?.users ?? []}
          scroll={{ x: 1100 }}
          columns={[
            {
              title: text("username"),
              dataIndex: "username",
              render: (name) => (
                <Typography.Text copyable>{name}</Typography.Text>
              ),
            },
            {
              title: text("role"),
              dataIndex: "role",
              render: (role) => (
                <Tag>
                  {text(role === "superadmin" ? "superadmin" : "regularUser")}
                </Tag>
              ),
            },
            {
              title: text("chat"),
              render: (_, user) => (
                <Space wrap>
                  <Tag color={user.chatPolicy.disabled ? "error" : "success"}>
                    {text(user.chatPolicy.disabled ? "disabled" : "enabled")}
                  </Tag>
                  <span>
                    {user.chatUsage.today}/
                    {user.chatUsage.limit ?? text("unlimited")}
                  </span>
                  <Tag>{text(user.activeRecently ? "online" : "offline")}</Tag>
                </Space>
              ),
            },
            {
              title: text("created"),
              dataIndex: "createdAt",
              render: fmtDateTime,
            },
            {
              title: text("dailyLimit"),
              render: (_, user) => (
                <DailyLimit
                  key={`${user.username}:${user.chatPolicy.dailyLimit}`}
                  user={user}
                  busy={busy}
                  onSave={(dailyLimit) =>
                    void run(() =>
                      updateChatPolicy(user.username, { dailyLimit }),
                    )
                  }
                />
              ),
            },
            {
              title: text("actions"),
              render: (_, user) => (
                <Space wrap>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        updateChatPolicy(user.username, {
                          disabled: !user.chatPolicy.disabled,
                        }),
                      )
                    }
                  >
                    {text(user.chatPolicy.disabled ? "enable" : "disable")}
                  </Button>
                  {user.role === "user" && <Button size="small" onClick={() => setMemberUser(user.username)}>{L('membershipRenew')}</Button>}
                  {user.role === "user" && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => setAccessUser(user.username)}
                    >
                      {text("quotaCredentials")}
                    </Button>
                  )}
                  {user.role === "user" && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => setRenameUser(user.username)}
                    >
                      {text("renameUser")}
                    </Button>
                  )}
                  <Button
                    size="small"
                    danger
                    disabled={busy}
                    onClick={() => void cutoff(user)}
                  >
                    {text("cutoff")}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {memberUser && <MemberUserPanel username={memberUser} onClose={() => setMemberUser(null)} />}
      {accessUser && (
        <UserAccessPanel
          key={accessUser}
          username={accessUser}
          onClose={() => setAccessUser(null)}
        />
      )}
      {renameTarget && (
        <RenameUserPanel
          username={renameTarget}
          onClose={() => setRenameUser(null)}
          onRenamed={() => void resource.reload()}
        />
      )}
    </div>
  );
}
function Audit(): JSX.Element {
  const text = useAdminText(),
    [username, setUsername] = useState(""),
    load = useCallback(() => loadAudit(username), [username]),
    resource = useResource(load);
  return (
    <Card>
      <Feedback error={resource.error} />
      <div className={styles.toolbar}>
        <p>{text("auditHint")}</p>
        <Space>
          <Select
            aria-label={text("filterUser")}
            style={{ minWidth: 180 }}
            value={username}
            onChange={setUsername}
            options={[
              { value: "", label: text("allUsers") },
              ...(resource.data?.usernames ?? []).map((value) => ({
                value,
                label: value,
              })),
            ]}
          />
          <Button onClick={() => void resource.reload()}>
            {text("refresh")}
          </Button>
        </Space>
      </div>
      <Table<AuditRecord>
        rowKey="id"
        loading={resource.loading}
        dataSource={resource.data?.records ?? []}
        scroll={{ x: 1000 }}
        expandable={{
          rowExpandable: (row) => row.kind !== "login_failed",
          expandedRowRender: (row) => (
            <Table
              rowKey={(_, index) => String(index)}
              pagination={false}
              dataSource={row.actions}
              columns={[
                {
                  title: text("created"),
                  dataIndex: "at",
                  render: fmtDateTime,
                },
                {
                  title: text("action"),
                  dataIndex: "action",
                  render: (action) => text(`auditAction_${action}`),
                },
                { title: text("detail"), dataIndex: "detail" },
                {
                  title: text("status"),
                  dataIndex: "ok",
                  render: (ok) => (
                    <Tag color={ok ? "success" : "error"}>
                      {text(ok ? "success" : "failed")}
                    </Tag>
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: text("username"), dataIndex: "username" },
          {
            title: text("type"),
            dataIndex: "kind",
            render: (kind) =>
              text(kind === "login_failed" ? "loginFailed" : "loginSession"),
          },
          {
            title: "IP",
            dataIndex: "ip",
            render: (ip, row) => <span title={row.userAgent}>{ip || "—"}</span>,
          },
          { title: text("created"), dataIndex: "at", render: fmtDateTime },
          {
            title: text("endedAt"),
            dataIndex: "endedAt",
            render: (value) => (value ? fmtDateTime(value) : "—"),
          },
          { title: text("actions"), render: (_, row) => row.actions.length },
          {
            title: text("status"),
            render: (_, row) => (
              <Tag>
                {text(
                  row.kind === "login_failed"
                    ? "failed"
                    : `audit_${row.status ?? "ended"}`,
                )}
              </Tag>
            ),
          },
        ]}
      />
    </Card>
  );
}
export default function AdminPage(): JSX.Element {
  return (
    <AdminViews
      items={[
        { key: "users", label: "userManagement", children: <Users /> },
        { key: "audit", label: "auditLogs", children: <Audit /> },
        {
          key: "website",
          label: "websiteSettings",
          children: <WebsiteSettings />,
        },
      ]}
    />
  );
}
