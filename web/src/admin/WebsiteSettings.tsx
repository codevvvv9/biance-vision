import { useState } from "react";
import { Button, Card, Form, Input, Slider } from "antd";
import {
  loadContacts,
  saveContacts,
  saveHeroGame,
  type Contacts,
  type HeroGame,
  type HeroGameRisk,
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
          onChange={(e) =>
            setContacts({ ...contacts, email: e.target.value })
          }
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
function HeroGameForm({
  initial,
  onSaved,
}: {
  initial: HeroGame;
  onSaved: () => void;
}): JSX.Element {
  const text = useAdminText();
  const [game, setGame] = useState(initial),
    [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  useDirtyForm(JSON.stringify(game) !== baseline);
  const updateRisk = (
    index: number,
    field: keyof HeroGameRisk,
    value: string,
  ) =>
    setGame({
      ...game,
      risks: game.risks.map((risk, i) =>
        i === index ? { ...risk, [field]: value } : risk,
      ),
    });
  const removeRisk = (index: number) =>
    setGame({ ...game, risks: game.risks.filter((_, i) => i !== index) });
  const addRisk = () =>
    setGame({
      ...game,
      risks: [...game.risks, { zh: "", en: "", glyph: "!" }],
    });
  const save = async () => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await saveHeroGame(game);
      setGame(result.heroGame);
      setBaseline(JSON.stringify(result.heroGame));
      setSuccess(
        text("heroGamePublished", { revision: result.heroGame.revision }),
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const speedMarks = {
    0.5: text("speedSlow"),
    1: text("speedStandard"),
    1.5: text("speedFast"),
    2: text("speedTurbo"),
  };
  return (
    <Form layout="vertical" onFinish={() => void save()}>
      <Feedback error={error} success={success} />
      <p>{text("heroGameHint")}</p>
      {game.risks.map((risk, index) => (
        <Form.Item key={index} label={text("riskRow", { index: index + 1 })}>
          <div className="hero-game-risk-row">
            <Input
              aria-label={text("riskZh")}
              placeholder={text("riskZh")}
              value={risk.zh}
              maxLength={8}
              onChange={(e) => updateRisk(index, "zh", e.target.value)}
            />
            <Input
              aria-label={text("riskEn")}
              placeholder={text("riskEn")}
              value={risk.en}
              maxLength={16}
              onChange={(e) => updateRisk(index, "en", e.target.value)}
            />
            <Input
              aria-label={text("riskGlyph")}
              placeholder={text("riskGlyph")}
              className="hero-game-risk-glyph"
              value={risk.glyph}
              maxLength={3}
              onChange={(e) => updateRisk(index, "glyph", e.target.value)}
            />
            <Button
              aria-label={text("removeRisk")}
              disabled={game.risks.length <= 3}
              onClick={() => removeRisk(index)}
            >
              {text("removeRisk")}
            </Button>
          </div>
        </Form.Item>
      ))}
      <Button disabled={game.risks.length >= 10} onClick={addRisk}>
        {text("addRisk")}
      </Button>
      <Form.Item label={text("heroSpeed")} htmlFor="hero-speed">
        <Slider
          id="hero-speed"
          min={0.5}
          max={2}
          step={0.05}
          marks={speedMarks}
          value={game.speedScale}
          onChange={(speedScale) => setGame({ ...game, speedScale })}
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>
        {text("publishHeroGame")}
      </Button>
    </Form>
  );
}
export function WebsiteSettings(): JSX.Element {
  const text = useAdminText(),
    resource = useResource(loadContacts);
  return (
    <>
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
      <Card
        title={text("websiteHeroGame")}
        style={{ marginTop: 16 }}
        extra={
          <Button onClick={() => void resource.reload()}>
            {text("refresh")}
          </Button>
        }
      >
        <Feedback error={resource.error} />
        {resource.data ? (
          resource.data.heroGame ? (
            <HeroGameForm
              key={resource.data.heroGame.revision}
              initial={resource.data.heroGame}
              onSaved={() => void resource.reload()}
            />
          ) : (
            <p>{text("heroGamePending")}</p>
          )
        ) : (
          resource.loading && <Loading />
        )}
      </Card>
    </>
  );
}
