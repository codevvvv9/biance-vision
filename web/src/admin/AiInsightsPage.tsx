import { useOutletContext } from "react-router-dom";
import type { AdminFeatureContext } from "./app/contracts";
import { AdminViews } from "./ui/views";
import { ResearchConversations } from "./features/ai/ResearchConversations";
import { LegacyConversations } from "./features/ai/LegacyConversations";
export default function AiInsightsPage(): JSX.Element {
  const { aiConfigRevision } = useOutletContext<AdminFeatureContext>();
  return (
    <AdminViews
      items={[
        {
          key: "research",
          label: "researchConversations",
          children: <ResearchConversations />,
        },
        {
          key: "legacy",
          label: "legacyConversations",
          children: <LegacyConversations configRevision={aiConfigRevision} />,
        },
      ]}
    />
  );
}
