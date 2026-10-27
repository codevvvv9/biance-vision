import {
  api,
  fetchAdminUsers,
  updateChatPolicy,
  cutOffUserChat,
} from "../../../api";
import type { AuditRecord } from "../../../types";
import type { MembershipGrantInput, MembershipStatus } from "biance-vision-brooks";
export { fetchAdminUsers, updateChatPolicy, cutOffUserChat };
export interface Contacts {
  version: 1;
  revision: number;
  telegram: string;
  email: string;
  updatedAt: number;
}
export interface HeroGameRisk {
  zh: string;
  en: string;
  glyph: string;
}
export interface HeroGame {
  version: 1;
  revision: number;
  risks: HeroGameRisk[];
  speedScale: number;
  updatedAt: number;
}
export interface Access {
  totalLimit: number;
  used?: number;
  dailyLimit: number | null;
  requestsPerMinute: number;
  profileName?: string;
}
export interface Delivery {
  username: string;
  password: string;
  publicOrigin: string | null;
  loginPath: string;
  membership: MembershipStatus;
}
export interface Profile {
  model: string;
  apiKeyMasked: string;
  maxTokens?: number;
  dailyLimit?: number;
}
export const loadContacts = () =>
  api<{ contacts: Contacts; heroGame: HeroGame }>("/admin/website-config");
export const saveContacts = (contacts: Contacts) =>
  api<{ contacts: Contacts }>("/admin/website-config", {
    method: "PUT",
    body: {
      telegram: contacts.telegram,
      email: contacts.email,
      expectedRevision: contacts.revision,
    },
  });
export const saveHeroGame = (heroGame: HeroGame) =>
  api<{ heroGame: HeroGame }>("/admin/website-config/hero-game", {
    method: "PUT",
    body: {
      risks: heroGame.risks,
      speedScale: heroGame.speedScale,
      expectedRevision: heroGame.revision,
    },
  });
export const loadProfiles = () =>
  api<{ profiles: Record<string, Profile> }>("/admin/ai/config");
export const provisionUser = (body: MembershipGrantInput & {username?: string}) => api<Delivery>("/admin/users/provision", { method: "POST", body });
export const loadAccess = (username: string) =>
  api<{ access: Access | null; membership?: MembershipStatus }>(
    `/admin/users/${encodeURIComponent(username)}/ai-access`,
  );
export const saveAccess = (username: string, access: Access) =>
  api<{ access: Access }>(
    `/admin/users/${encodeURIComponent(username)}/ai-access`,
    {
      method: "PUT",
      body: {
        totalLimit: access.totalLimit,
        dailyLimit: access.dailyLimit,
        requestsPerMinute: access.requestsPerMinute,
      },
    },
  );
export const resetCredentials = (username: string, password?: string) =>
  api<{ password: string }>(
    `/admin/users/${encodeURIComponent(username)}/reset-credentials`,
    { method: "POST", body: password ? { password } : {} },
  );
export interface RenameResult {
  from: string;
  to: string;
  migrated: Record<string, number>;
}
export const renameUser = (username: string, to: string) =>
  api<RenameResult>(
    `/admin/users/${encodeURIComponent(username)}/rename`,
    { method: "POST", body: { to } },
  );
export const loadAudit = (username: string) =>
  api<{ records: AuditRecord[]; usernames: string[] }>(
    `/admin/audit-logs${username ? `?username=${encodeURIComponent(username)}` : ""}`,
  );
