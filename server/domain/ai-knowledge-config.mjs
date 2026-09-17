// Explicit knowledge-only preset. Never reuse a key with an arbitrary inherited endpoint.
export function knowledgeProviderEnv(env = {}) {
  if (env.FLOWCHAIN_KNOWLEDGE_PROVIDER === 'qwen') {
    const region = String(env.FLOWCHAIN_QWEN_REGION || '')
    const workspace = String(env.FLOWCHAIN_QWEN_WORKSPACE_ID || '').trim()
    const validWorkspace = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workspace)
    const base = validWorkspace && ['ap-southeast-1', 'cn-beijing', 'cn-hongkong'].includes(region)
      ? `https://${workspace}.${region}.maas.aliyuncs.com/compatible-mode/v1` : ''
    return {
      ...env,
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'qwen_chat',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: base ? `${base}/chat/completions` : '',
      FLOWCHAIN_AI_PROVIDER_API_KEY: String(env.DASHSCOPE_API_KEY || '').trim(),
      FLOWCHAIN_AI_PROVIDER_MODEL: env.FLOWCHAIN_QWEN_MODEL || 'qwen-flash',
      FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '15000',
      FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: '12000',
      FLOWCHAIN_AI_EMBEDDING_ENDPOINT: base ? `${base}/embeddings` : '',
      FLOWCHAIN_AI_EMBEDDING_API_KEY: String(env.DASHSCOPE_API_KEY || '').trim(),
      FLOWCHAIN_AI_EMBEDDING_MODEL: env.FLOWCHAIN_QWEN_EMBEDDING_MODEL || 'text-embedding-v4',
      FLOWCHAIN_AI_EMBEDDING_DIMENSIONS: env.FLOWCHAIN_QWEN_EMBEDDING_DIMENSIONS || '1024',
      FLOWCHAIN_AI_EMBEDDING_BATCH_SIZE: '10',
    }
  }
  if (env.FLOWCHAIN_KNOWLEDGE_PROVIDER !== 'openai') return env
  const key = String(env.FLOWCHAIN_KNOWLEDGE_API_KEY || env.OPENAI_API_KEY || '').trim()
  return {
    ...env,
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses',
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://api.openai.com/v1/responses',
    FLOWCHAIN_AI_PROVIDER_API_KEY: key,
    FLOWCHAIN_AI_PROVIDER_MODEL: env.FLOWCHAIN_KNOWLEDGE_MODEL || 'gpt-4.1-mini',
    FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '15000',
    FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: '12000',
    FLOWCHAIN_AI_EMBEDDING_ENDPOINT: 'https://api.openai.com/v1/embeddings',
    FLOWCHAIN_AI_EMBEDDING_API_KEY: key,
    FLOWCHAIN_AI_EMBEDDING_MODEL: env.FLOWCHAIN_KNOWLEDGE_EMBEDDING_MODEL || 'text-embedding-3-small',
    FLOWCHAIN_AI_EMBEDDING_DIMENSIONS: env.FLOWCHAIN_KNOWLEDGE_EMBEDDING_DIMENSIONS || '1536',
  }
}
