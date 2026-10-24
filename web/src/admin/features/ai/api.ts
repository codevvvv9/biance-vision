import {
  api,
  fetchAdminUsers,
  fetchAdminConversation,
  fetchAdminConversations,
} from "../../../api";
import type {
  AiProfileMasked,
  AiConversationSummary,
  AiMemoryItem,
  AiUserStat,
  AiConversationDetail,
} from "../../../types";
export interface UserPanorama {
  username: string;
  profileName: string;
  profileConfigured: boolean;
  profileMasked: AiProfileMasked | null;
  prompt: string;
  conversations: AiConversationSummary[];
  memories: AiMemoryItem[];
}
export const loadAiUsers = fetchAdminUsers;
export const loadResearchConversations = fetchAdminConversations;
export const loadResearchConversation = fetchAdminConversation;
export const loadAiOverview = () =>
  api<{ stats: AiUserStat[] }>("/admin/ai/overview");
export const loadUserPanorama = (username: string) =>
  api<UserPanorama>(`/admin/ai/user?username=${encodeURIComponent(username)}`);
export const loadLegacyConversation = (id: string) =>
  api<{ conversation: AiConversationDetail }>(
    `/admin/ai/conversations/${encodeURIComponent(id)}`,
  );
