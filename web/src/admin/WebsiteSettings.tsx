import { useState } from "react";
import { Button, Card, Form, Input } from "antd";
import {
  loadContacts,
  saveContacts,
  type Contacts,
} from "./features/panel/api";
import { useResource } from "./ui/resource";
import { Feedback, Loading } from "./ui/feedback";
import { useAdminText } from "./ui/text";
import { useDirtyForm } from "./ui/forms";
function ContactForm({
  initial,
  onSaved,
}: {
  initial: Contacts;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const [contacts, setContacts] = useState(initial),
    [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  useDirtyForm(JSON.stringify(contacts) !== baseline);
  const save = async () => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await saveContacts(contacts);
      setContacts(result.contacts);
      setBaseline(JSON.stringify(result.contacts));
      setSuccess(
        text("contactsPublished", { revision: result.contacts.revision }),
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form layout="vertical" onFinish={() => void save()}>
      <Feedback error={error} success={success} />
      <p>{text("publicContactHint")}</p>
      <Form.Item label={text("telegram")} htmlFor="website-telegram">
        <Input
          id="website-telegram"
          value={contacts.telegram}
          autoComplete="off"
          maxLength={33}
          onChange={(e) =>
            setContacts({ ...contacts, telegram: e.target.value })
          }
        />
      </Form.Item>
      <Form.Item label={text("contactEmail")} htmlFor="website-email">
        <Input
          id="website-email"
          type="email"
          value={contacts.email}
          maxLength={254}
          onChange={(e) => setContacts({ ...contacts, email: e.target.value })}
        />
      </Form.Item>
      <Button
        type="primary"
        htmlType="submit"
        loading={busy}
        disabled={!contacts.email.trim() && !contacts.telegram.trim()}
      >
        {text("publishContacts")}
      </Button>
    </Form>
  );
}
export function WebsiteSettings(): JSX.Element {
  const text = useAdminText(),
    resource = useResource(loadContacts);
  return (
    <Card
      title={text("websiteContacts")}
      extra={
        <Button onClick={() => void resource.reload()}>
          {text("refresh")}
        </Button>
      }
    >
      <Feedback error={resource.error} />
      {resource.data ? (
        <ContactForm
          key={resource.data.contacts.revision}
          initial={resource.data.contacts}
          onSaved={() => void resource.reload()}
        />
      ) : (
        resource.loading && <Loading />
      )}
    </Card>
  );
}
