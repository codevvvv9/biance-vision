import { Drawer } from "../../ui/overlays";
import { useCallback, useMemo, useState } from "react";
import { Card, Collapse, Descriptions, Table, Typography, Button } from "antd";
import type { AiConversationSummary, AiUserStat } from "../../../types";
import {
  loadAiOverview,
  loadLegacyConversation,
  loadUserPanorama,
} from "./api";
import { LegacyMessages } from "./Messages";
import { EChart } from "../../charts/EChart";
import { aiActivityOption } from "../../charts/options";
import { useResource } from "../../ui/resource";
import { Feedback } from "../../ui/feedback";
import { useAdminText } from "../../ui/text";
import styles from "../../ui/admin.module.css";
function Conversation({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(() => loadLegacyConversation(id), [id]);
  const resource = useResource(load);
  return (
    <Drawer
      open
      title={text("conversationDetail")}
      size={800}
      onClose={onClose}
      loading={resource.loading}
    >
      <Feedback error={resource.error} />
      {resource.data && (
        <LegacyMessages conversation={resource.data.conversation} />
      )}
    </Drawer>
  );
}
function Panorama({
  username,
  configRevision,
  onClose,
}: {
  username: string;
  configRevision: number;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(
    () => loadUserPanorama(username),
    [username, configRevision],
  );
  const resource = useResource(load);
  const [conversation, setConversation] = useState<string | null>(null);
  const panorama = resource.data;
  return (
    <Drawer
      open
      title={`${username} · ${text("profileConfig")}`}
      size={1000}
      onClose={onClose}
      loading={resource.loading}
    >
      <div className={styles.stack}>
        <Feedback error={resource.error} />
        {panorama && (
          <>
            <Card title={text("profileConfig")}>
              {panorama.profileConfigured && panorama.profileMasked ? (
                <Descriptions
                  column={1}
                  size="small"
                  items={[
                    {
                      key: "profile",
                      label: text("profile"),
                      children: panorama.profileName,
                    },
                    ...Object.entries(panorama.profileMasked).map(
                      ([key, value]) => ({
                        key,
                        label: key,
                        children:
                          typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value),
                      }),
                    ),
                  ]}
                />
              ) : (
                <Typography.Text type="secondary">
                  {text("noProfile")}
                </Typography.Text>
              )}
            </Card>
            <Card title={text("memories")}>
              <Table
                rowKey="id"
                dataSource={panorama.memories}
                pagination={false}
                scroll={{ x: 550 }}
                columns={[
                  { title: text("kind"), dataIndex: "kind" },
                  { title: text("content"), dataIndex: "content" },
                  {
                    title: text("updated"),
                    dataIndex: "updatedAt",
                    render: (value) => new Date(value).toLocaleString(),
                  },
                ]}
              />
            </Card>
            <Card title={text("legacyConversations")}>
              <Table<AiConversationSummary>
                rowKey="id"
                dataSource={panorama.conversations}
                scroll={{ x: 600 }}
                columns={[
                  {
                    title: text("conversation"),
                    dataIndex: "title",
                    render: (title, item) => (
                      <Button
                        type="link"
                        onClick={() => setConversation(item.id)}
                      >
                        {title}
                      </Button>
                    ),
                  },
                  { title: text("messages"), dataIndex: "messageCount" },
                  {
                    title: text("created"),
                    dataIndex: "createdAt",
                    render: (value) => new Date(value).toLocaleString(),
                  },
                  {
                    title: text("updated"),
                    dataIndex: "updatedAt",
                    render: (value) => new Date(value).toLocaleString(),
                  },
                ]}
              />
            </Card>
            <Collapse
              items={[
                {
                  key: "prompt",
                  label: text("systemPrompt"),
                  children: (
                    <pre className={styles.pre}>{panorama.prompt || "—"}</pre>
                  ),
                },
              ]}
            />
          </>
        )}
        {conversation && (
          <Conversation
            key={conversation}
            id={conversation}
            onClose={() => setConversation(null)}
          />
        )}
      </div>
    </Drawer>
  );
}
export function LegacyConversations({
  configRevision,
}: {
  configRevision: number;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(() => loadAiOverview(), [configRevision]);
  const resource = useResource(load);
  const [username, setUsername] = useState<string | null>(null);
  const stats = resource.data?.stats ?? [];
  const activityChart = useMemo(
    () => (stats.some((s) => s.messages > 0) ? aiActivityOption(stats) : null),
    [stats],
  );
  return (
    <Card>
      <div className={styles.stack}>
        <Typography.Paragraph type="secondary">
          {text("legacyHint")}
        </Typography.Paragraph>
        <Feedback error={resource.error} />
        {activityChart !== null && (
          <>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {text("chartAiActivity")}
            </Typography.Title>
            <EChart option={activityChart} height={Math.max(160, stats.length * 34 + 60)} />
          </>
        )}
        <Table<AiUserStat>
          rowKey="username"
          loading={resource.loading}
          dataSource={resource.data?.stats ?? []}
          scroll={{ x: 750 }}
          columns={[
            {
              title: text("user"),
              dataIndex: "username",
              render: (username) => (
                <Button type="link" onClick={() => setUsername(username)}>
                  {username}
                </Button>
              ),
            },
            { title: text("profile"), dataIndex: "profileName" },
            { title: text("legacyConversations"), dataIndex: "conversations" },
            { title: text("messages"), dataIndex: "messages" },
            { title: text("memories"), dataIndex: "memories" },
            {
              title: text("updated"),
              dataIndex: "lastActiveAt",
              render: (value) =>
                value ? new Date(value).toLocaleString() : "—",
            },
          ]}
        />
        {username && (
          <Panorama
            key={username}
            username={username}
            configRevision={configRevision}
            onClose={() => setUsername(null)}
          />
        )}
      </div>
    </Card>
  );
}
