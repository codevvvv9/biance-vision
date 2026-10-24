import { Drawer } from "../../ui/overlays";
import { useCallback, useState } from "react";
import { Button, Card, Select, Space, Table } from "antd";
import type { AdminConversationSummary } from "../../../types";
import {
  loadAiUsers,
  loadResearchConversation,
  loadResearchConversations,
} from "./api";
import { ResearchMessages } from "./Messages";
import { useResource } from "../../ui/resource";
import { Feedback } from "../../ui/feedback";
import { useAdminText } from "../../ui/text";
import styles from "../../ui/admin.module.css";
function Detail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(() => loadResearchConversation(id), [id]);
  const resource = useResource(load);
  return (
    <Drawer
      open
      title={resource.data?.conversation.title ?? text("conversationDetail")}
      size={900}
      onClose={onClose}
      loading={resource.loading}
    >
      <Feedback error={resource.error} />
      {resource.data && <ResearchMessages detail={resource.data} />}
    </Drawer>
  );
}
function ConversationList({ username }: { username: string }): JSX.Element {
  const text = useAdminText();
  const load = useCallback(
    () => loadResearchConversations(username),
    [username],
  );
  const resource = useResource(load);
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <>
      <Feedback error={resource.error} />
      <Table<AdminConversationSummary>
        rowKey="id"
        loading={resource.loading}
        dataSource={resource.data?.conversations ?? []}
        scroll={{ x: 650 }}
        columns={[
          {
            title: text("conversation"),
            dataIndex: "title",
            render: (title, conversation) => (
              <Button
                type="link"
                style={{ padding: 0 }}
                onClick={() => setDetail(conversation.id)}
              >
                {title}
              </Button>
            ),
          },
          { title: text("messages"), dataIndex: "messageCount" },
          {
            title: text("updated"),
            dataIndex: "updatedAt",
            render: (value) => new Date(value).toLocaleString(),
          },
          {
            title: text("source"),
            render: (_, conversation) => (
              <Space>
                {conversation.context.symbol ?? "—"}{" "}
                {conversation.context.horizon ?? ""}
              </Space>
            ),
          },
        ]}
      />
      {detail && (
        <Detail key={detail} id={detail} onClose={() => setDetail(null)} />
      )}
    </>
  );
}
export function ResearchConversations(): JSX.Element {
  const text = useAdminText();
  const users = useResource(loadAiUsers);
  const [username, setUsername] = useState("");
  return (
    <Card>
      <div className={styles.stack}>
        <Feedback error={users.error} />
        <div className={styles.filters}>
          <Select
            aria-label={text("chooseUser")}
            placeholder={text("chooseUser")}
            loading={users.loading}
            showSearch
            value={username || undefined}
            onChange={setUsername}
            options={(users.data?.users ?? []).map((user) => ({
              value: user.username,
              label: user.username,
            }))}
          />
        </div>
        {username && <ConversationList key={username} username={username} />}
      </div>
    </Card>
  );
}
