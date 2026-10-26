import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiProfile } from '../ai.js'
export interface MemberCallContext {
  username?: string
  chat?: AiProfile
  research?: AiProfile
  chatName?: string
  researchName?: string
  features?: { chat: boolean; research: boolean; translate: boolean }
  versionId?: string
  revision?: number
}
export const memberCalls = new AsyncLocalStorage<MemberCallContext>()
