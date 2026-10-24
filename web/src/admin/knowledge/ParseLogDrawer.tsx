import { useCallback } from "react";
import { Descriptions, Empty, Tag, Timeline, Typography } from "antd";
import type { KnowledgeEventsResponse } from "biance-vision-brooks";
import { api } from "../../api";
import { Drawer } from "../ui/overlays";
import { useResource } from "../ui/resource";
import { useAdminText } from "../ui/text";
import { Feedback } from "../ui/feedback";
import { DocumentStatus } from "../features/knowledge/Documents";
const stageColors: Record<string, string> = {
  parsing: "blue",
  chunking: "blue",
  embedding: "blue",
  completed: "green",
  failed: "red",
  route: "purple",
};
export default function ParseLogDrawer({
  docId,
  onClose,
}: {
  docId: string;
  onClose: () => void;
}): JSX.Element {
  const text = useAdminText();
  const load = useCallback(
    () =>
      api<KnowledgeEventsResponse>(
        `/admin/knowledge/documents/${encodeURIComponent(docId)}/events`,
      ),
    [docId],
  );
  const resource = useResource(load);
  const data = resource.data,
    events = data?.events ?? [];
  const start = events[0]?.atMs ?? 0;
  return (
    <Drawer
      open
      title={`${text("logs")}${data ? ` · ${data.title}` : ""}`}
      size={760}
      onClose={onClose}
      loading={resource.loading}
    >
      <Feedback error={resource.error} />
      {data && (
        <>
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: "status",
                label: text("status"),
                children: <DocumentStatus status={data.status} />,
              },
              { key: "run", label: text("parseAttempt"), children: data.runNo },
              {
                key: "duration",
                label: text("totalDuration"),
                children: events.length
                  ? `${events[events.length - 1].atMs - start}ms`
                  : "—",
              },
              {
                key: "attempt",
                label: text("attemptId"),
                children: data.attemptId ?? "—",
              },
            ]}
          />
          {!data.hasEvents && <Empty description={text("noHistoricalLogs")} />}
          <Timeline
            items={events.map((event) => ({
              color: stageColors[event.stage] ?? "gray",
              content: (
                <div>
                  <Tag>{event.stage}</Tag>
                  <Typography.Paragraph>
                    {event.message ?? ""}
                  </Typography.Paragraph>
                  <Typography.Text type="secondary">
                    +{event.atMs - start}ms
                    {event.durationMs != null ? ` · ${event.durationMs}ms` : ""}
                  </Typography.Text>
                </div>
              ),
            }))}
          />
        </>
      )}
    </Drawer>
  );
}
