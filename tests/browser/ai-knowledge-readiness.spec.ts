import { test, expect, type Page } from '@playwright/test';

async function openAssistant(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: 'admin@example.com', name: 'Admin', company: 'Demo' } });
  expect(response.ok()).toBeTruthy();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('flowchain:auth-token', token);
    localStorage.setItem('flowchain:current-user', JSON.stringify(user));
  }, await response.json());
  await page.route('**/api/me/localization', route => route.fulfill({ json: { effectiveLanguage: 'en-US', languagePreference: 'en-US', defaultLanguage: 'en-US', locale: 'en-US', timezone: 'America/New_York' } }));
  await page.goto('/app/overview/risks');
  await page.getByTestId('ai-assistant-toggle').click();
  // No search-mode select: the server picks records or documents from the question.
  await expect(page.getByTestId('ai-assistant-panel')).toBeVisible();
  await expect(page.getByTestId('ai-query-mode')).toHaveCount(0);
}

// The knowledge library sits behind the panel's "More" menu.
async function openLibrary(page: Page) {
  await page.getByTestId('ai-more-menu').click();
  await page.getByTestId('ai-knowledge-library').click();
}

test('library exposes keyword readiness, persists failed attempt, and retries visibly', async ({ page }) => {
  let failed = true;
  await page.route('**/api/ai-runtime/knowledge', route => route.fulfill({ json: {
    canManage: true, capabilities: { embeddingConfigured: true, model: 'test-v1', dimensions: 2, vectorStorage: 'local_vectors' },
    items: [{ id: 'guide', title: 'Product guide', _count: { chunks: 2 }, indexStatus: failed ? 'keyword' : 'semantic', indexedChunks: failed ? 0 : 2, indexAttemptStatus: failed ? 'failed' : 'ready', indexAttemptError: failed ? 'KNOWLEDGE_EMBEDDING_UNAVAILABLE' : null, embeddingModel: failed ? null : 'test-v1', embeddingDimensions: failed ? null : 2 }],
  } }));
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/ai-runtime/knowledge/guide/reindex', async route => { await held; failed = false; await route.fulfill({ json: { indexStatus: 'semantic' } }); });
  await openAssistant(page);
  await openLibrary(page);
  const library = page.getByTestId('knowledge-library');
  await expect(library).toContainText('The previous index was kept');
  await library.getByRole('button', { name: 'Retry indexing' }).click();
  await expect(library.getByTestId('knowledge-document-row')).toContainText('Processing');
  await expect(library.getByRole('button', { name: 'Indexing…', exact: true })).toBeDisabled();
  finish();
  await expect(library).toContainText('Ready · semantic');
  await expect(library).toContainText('2 / 2 passages embedded');
  await expect(library).not.toContainText(/[\u3400-\u9fff]/);
});
