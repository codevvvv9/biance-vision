export const DEFAULT_CONFIG = {
  capabilities: {
    chat: { enabled: false },
    embedding: { enabled: false },
    rerank: { enabled: false },
    vision: { enabled: false },
    search: { enabled: false },
  },
  roles: [
    {
      name: "brooks_analyst",
      promptRef: "brooks_analyst",
      tools: ["market_snapshot", "brooks_engine", "knowledge_retrieval"],
      budget: {},
    },
  ],
  retrieval: {
    variants: 2,
    candidateLimit: 40,
    finalLimit: 8,
    counterFinalLimit: 5,
    rerank: true,
    adjacency: true,
  },
  budgets: { maxToolCalls: 40, maxRuntimeMs: 300000 },
  ruleParams: {},
};
