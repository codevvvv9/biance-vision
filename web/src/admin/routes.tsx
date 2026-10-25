import type { ComponentType } from "react";
interface RouteMeta {
  id: string;
  labelKey: string;
  hintKey: string;
  icon: JSX.Element;
  load: () => Promise<{ default: ComponentType }>;
}
export type AdminRouteDef = RouteMeta &
  ({ index: true; path?: never } | { path: string; index?: never });
function LogIcon(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}

function ChatLogIcon(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="13" y2="13" />
    </svg>
  );
}

function BookIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
    </svg>
  );
}

function TuneIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h-1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="19" cy="18" r="2" />
    </svg>
  );
}

function ChartIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

function PromptIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 5h16M4 12h10M4 19h7" />
      <path d="M17.5 14.5 21 18l-3.5 3.5" />
    </svg>
  );
}

/** Paths are internal to the router basename; no deployment prefixes. */
export const ADMIN_ROUTES: AdminRouteDef[] = [
  {
    id: "panel",
    index: true,
    labelKey: "menu.panel",
    hintKey: "menu.panelHint",
    icon: <LogIcon />,
    load: () => import("./AdminPage"),
  },
  {
    id: "ai",
    path: "ai",
    labelKey: "menu.ai",
    hintKey: "menu.aiHint",
    icon: <ChatLogIcon />,
    load: () => import("./AiInsightsPage"),
  },
  {
    id: "knowledge",
    path: "knowledge",
    labelKey: "menu.knowledge",
    hintKey: "menu.knowledgeHint",
    icon: <BookIcon />,
    load: () => import("./AdminKnowledgePage"),
  },
  {
    id: "agents",
    path: "agents",
    labelKey: "menu.agents",
    hintKey: "menu.agentsHint",
    icon: <TuneIcon />,
    load: () => import("./AdminAgentsPage"),
  },
  {
    id: "prompts",
    path: "prompts",
    labelKey: "menu.prompts",
    hintKey: "menu.promptsHint",
    icon: <PromptIcon />,
    load: () => import("./AdminPromptsPage"),
  },
  {
    id: "evals",
    path: "evals",
    labelKey: "menu.evals",
    hintKey: "menu.evalsHint",
    icon: <ChartIcon />,
    load: () => import("./AdminEvalsPage"),
  },
  {
    id: "observability",
    path: "observability",
    labelKey: "menu.observability",
    hintKey: "menu.observabilityHint",
    icon: <ChartIcon />,
    load: () => import("./AdminObservabilityPage"),
  },
];
