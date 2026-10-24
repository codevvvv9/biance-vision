import { Modal, overlayContainer } from "./ui/overlays";
import { useState } from "react";
import {
  App,
  Button,
  Card,
  Collapse,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  loadTemplates,
  templateAction,
  type TemplateDto,
} from "./features/prompts/api";
import { TemplateEditor } from "./features/prompts/TemplateEditor";
import { Disclaimers, InputConfig } from "./features/prompts/Settings";
import { lineDiff } from "./features/prompts/diff";
import { useResource } from "./ui/resource";
import { useAdminText } from "./ui/text";
import { Feedback } from "./ui/feedback";
import { AdminViews } from "./ui/views";
import styles from "./ui/admin.module.css";
function Templates(): JSX.Element {
  const text = useAdminText();
  const { modal } = App.useApp();
  const resource = useResource(loadTemplates);
  const [editing, setEditing] = useState<TemplateDto | "new" | null>(null);
  const [compare, setCompare] = useState<TemplateDto | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const pointer = (template: TemplateDto) =>
    resource.data?.pointers.find(
      (item) => item.name === template.name && item.scene === template.scene,
    )?.publishedId;
  const active = compare
    ? resource.data?.templates.find((item) => item.id === pointer(compare))
    : undefined;
  const act = async (template: TemplateDto, action: "publish" | "rollback") => {
    if (
      busy ||
      !(await modal.confirm({
        getContainer: overlayContainer,
        title: `${text(action)} · ${template.name} v${template.version}`,
        content: text("versionImpact"),
        okText: text("confirm"),
        cancelText: text("cancel"),
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await templateAction(template.id, action);
      setSuccess(text("operationDone"));
      await resource.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <Feedback error={error || resource.error} success={success} />
      <Card>
        <div className={styles.toolbar}>
          <Typography.Text type="secondary">
            {text("promptHint")}
          </Typography.Text>
          <Button type="primary" onClick={() => setEditing("new")}>
            {text("newDraft")}
          </Button>
        </div>
        <Table<TemplateDto>
          rowKey="id"
          loading={resource.loading || busy}
          dataSource={resource.data?.templates ?? []}
          scroll={{ x: 900 }}
          columns={[
            { title: text("template"), dataIndex: "name", width: 220 },
            {
              title: text("scope"),
              dataIndex: "scene",
              render: (scene) => scene || text("global"),
            },
            {
              title: text("version"),
              dataIndex: "version",
              render: (version, template) => (
                <Space>
                  v{version}
                  {template.id === pointer(template) && (
                    <Tag color="success">{text("current")}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: text("status"),
              dataIndex: "status",
              render: (status) => (
                <Tag color={status === "draft" ? "warning" : undefined}>
                  {text(status)}
                </Tag>
              ),
            },
            { title: text("note"), dataIndex: "note", ellipsis: true },
            {
              title: text("actions"),
              width: 290,
              render: (_, template) => (
                <Space wrap size={4}>
                  {template.status === "draft" ? (
                    <>
                      <Button size="small" onClick={() => setEditing(template)}>
                        {text("edit")}
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => void act(template, "publish")}
                      >
                        {text("publish")}
                      </Button>
                    </>
                  ) : (
                    template.id !== pointer(template) && (
                      <Button
                        size="small"
                        onClick={() => void act(template, "rollback")}
                      >
                        {text("rollback")}
                      </Button>
                    )
                  )}
                  <Button size="small" onClick={() => setCompare(template)}>
                    {text("compare")}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Collapse
        items={[
          {
            key: "help",
            label: text("placeholderHelp"),
            children: (
              <Typography.Paragraph>
                <code>
                  {
                    "{{vertical}} · {{traderProfile}} · {{memory}} · {{knowledgeVersion}}"
                  }
                </code>
                <br />
                {text("versionImpact")}
                <br />
                {text("citationFormat")}
              </Typography.Paragraph>
            ),
          },
        ]}
      />
      {editing && (
        <TemplateEditor
          key={editing === "new" ? "new" : editing.id}
          template={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void resource.reload()}
        />
      )}
      <Modal
        title={
          compare
            ? `${text("compare")} · ${compare.name} v${compare.version}`
            : ""
        }
        open={compare !== null}
        onCancel={() => setCompare(null)}
        footer={null}
        width={900}
      >
        <pre className={styles.pre}>
          {compare &&
            lineDiff(active?.content ?? "", compare.content).map(
              (line, index) => (
                <span
                  key={index}
                  className={
                    line.kind === "add"
                      ? styles.diffAdd
                      : line.kind === "del"
                        ? styles.diffDel
                        : undefined
                  }
                >{`${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}\n`}</span>
              ),
            )}
        </pre>
      </Modal>
    </div>
  );
}
export default function AdminPromptsPage(): JSX.Element {
  return (
    <AdminViews
      items={[
        { key: "templates", label: "templates", children: <Templates /> },
        { key: "copy", label: "researchCopy", children: <Disclaimers /> },
        { key: "input", label: "inputConfig", children: <InputConfig /> },
      ]}
    />
  );
}
