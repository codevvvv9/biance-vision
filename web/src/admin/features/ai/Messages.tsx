import { Descriptions, Empty, Space, Tag, Typography } from "antd";
import type {
  AdminConversationDetail,
  AdminMessageCard,
  AiConversationDetail,
} from "../../../types";
import { useAdminText } from "../../ui/text";
import styles from "../../ui/admin.module.css";
function MessageCard({ card }: { card: AdminMessageCard }): JSX.Element {
  const text = useAdminText();
  return (
    <div>
      <Tag>
        {text(
          card.kind === "confirm_position" ? "positionCard" : "completionCard",
        )}
      </Tag>
      <Tag color={card.complete ? "success" : "warning"}>
        {card.complete
          ? text("completeFields")
          : text("missingFields", {
              fields: (card.missingFields ?? []).join(", "),
            })}
      </Tag>
      <Descriptions
        size="small"
        column={1}
        items={Object.entries(card.draft).map(([key, value]) => ({
          key,
          label: key,
          children:
            typeof value === "object" ? JSON.stringify(value) : String(value),
        }))}
      />
    </div>
  );
}
export function ResearchMessages({
  detail,
}: {
  detail: AdminConversationDetail;
}): JSX.Element {
  const text = useAdminText();
  const context = detail.conversation.context;
  return (
    <div className={styles.stack}>
      <Space wrap>
        {[context.product, context.symbol, context.marketType, context.horizon]
          .filter(Boolean)
          .map((value, index) => (
            <Tag key={index}>{value}</Tag>
          ))}
        {(context.positionId ||
          (context.draft && Object.keys(context.draft).length > 0)) && (
          <Tag>{text("positionDraft")}</Tag>
        )}
      </Space>
      {detail.messages.length === 0 && (
        <Empty description={text("emptyMessages")} />
      )}
      {detail.messages.map((message) => {
        const run = message.runId ? detail.runs[message.runId] : undefined;
        return (
          <article
            key={message.id}
            className={styles.message}
            data-role={message.role}
          >
            <Space wrap>
              <Typography.Text strong>
                {text(`role_${message.role}`)}
              </Typography.Text>
              {message.intent && <Tag>{message.intent}</Tag>}
              {message.runId && (
                <Tag title={message.runId}>
                  {run
                    ? `${run.status} · ${run.product}/${run.symbol} ${run.horizon}`
                    : message.runId.slice(0, 8)}
                </Tag>
              )}
              <Typography.Text type="secondary">
                {new Date(message.createdAt).toLocaleString()}
              </Typography.Text>
            </Space>
            {message.content && <div>{message.content}</div>}
            {message.card && <MessageCard card={message.card} />}
          </article>
        );
      })}
    </div>
  );
}
export function LegacyMessages({
  conversation,
}: {
  conversation: AiConversationDetail;
}): JSX.Element {
  const text = useAdminText();
  return (
    <div className={styles.stack}>
      {conversation.messages.length === 0 && (
        <Empty description={text("emptyMessages")} />
      )}
      {conversation.messages.map((message, index) => (
        <article
          key={index}
          className={styles.message}
          data-role={message.role}
        >
          <Space>
            <Typography.Text strong>
              {text(`role_${message.role}`)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {new Date(message.at).toLocaleString()}
            </Typography.Text>
          </Space>
          <div>{message.content}</div>
        </article>
      ))}
    </div>
  );
}
