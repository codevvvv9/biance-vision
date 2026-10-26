import type { ComponentType } from "react";
import {
  FcComboChart,
  FcComments,
  FcDataConfiguration,
  FcLibrary,
  FcParallelTasks,
  FcRadarPlot,
  FcRatings,
  FcSettings,
  FcTodoList,
  FcVip,
} from "react-icons/fc";
interface RouteMeta {
  id: string;
  labelKey: string;
  hintKey: string;
  icon: JSX.Element;
  load: () => Promise<{ default: ComponentType }>;
}
export type AdminRouteDef = RouteMeta &
  ({ index: true; path?: never } | { path: string; index?: never });

/** Paths are internal to the router basename; no deployment prefixes. */
export const ADMIN_ROUTES: AdminRouteDef[] = [
  {
    id: "dashboard",
    index: true,
    labelKey: "menu.dashboard",
    hintKey: "menu.dashboardHint",
    icon: <FcComboChart />,
    load: () => import("./AdminDashboardPage"),
  },
  {
    id: "panel",
    path: "panel",
    labelKey: "menu.panel",
    hintKey: "menu.panelHint",
    icon: <FcSettings />,
    load: () => import("./AdminPage"),
  },
  { id: "membership", path: "membership", labelKey: "menu.membership", hintKey: "menu.membershipHint", icon: <FcVip />, load: () => import("./AdminMembershipPage") },
  {
    id: "ai",
    path: "ai",
    labelKey: "menu.ai",
    hintKey: "menu.aiHint",
    icon: <FcComments />,
    load: () => import("./AiInsightsPage"),
  },
  {
    id: "knowledge",
    path: "knowledge",
    labelKey: "menu.knowledge",
    hintKey: "menu.knowledgeHint",
    icon: <FcLibrary />,
    load: () => import("./AdminKnowledgePage"),
  },
  {
    id: "agents",
    path: "agents",
    labelKey: "menu.agents",
    hintKey: "menu.agentsHint",
    icon: <FcDataConfiguration />,
    load: () => import("./AdminAgentsPage"),
  },
  {
    id: "prompts",
    path: "prompts",
    labelKey: "menu.prompts",
    hintKey: "menu.promptsHint",
    icon: <FcTodoList />,
    load: () => import("./AdminPromptsPage"),
  },
  {
    id: "evals",
    path: "evals",
    labelKey: "menu.evals",
    hintKey: "menu.evalsHint",
    icon: <FcRatings />,
    load: () => import("./AdminEvalsPage"),
  },
  {
    id: "queues",
    path: "queues",
    labelKey: "menu.queues",
    hintKey: "menu.queuesHint",
    icon: <FcParallelTasks />,
    load: () => import("./AdminQueuesPage"),
  },
  {
    id: "observability",
    path: "observability",
    labelKey: "menu.observability",
    hintKey: "menu.observabilityHint",
    icon: <FcRadarPlot />,
    load: () => import("./AdminObservabilityPage"),
  },
];
