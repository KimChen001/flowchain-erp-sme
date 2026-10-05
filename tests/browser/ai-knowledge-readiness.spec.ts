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
  await expect(page.getByTestId('ai-query-mode')).toHaveValue('auto');
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
  await page.getByTestId('ai-knowledge-library').click();
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

test('cited passage is highlighted and mixed results keep business evidence visible', async ({ page }) => {
  await page.route('**/api/ai-runtime/respond', async route => {
    expect(route.request().postDataJSON().queryMode).toBe('auto');
    await route.fulfill({ json: {
      version: 'v2', intent: 'data_quality', query: 'Which records are incomplete according to company policy?', scope: { module: 'overview', dataScopeLabel: 'Current workspace' },
      conclusion: { title: 'Business records checked', summary: 'Two records need review.', confidence: 'high', severity: 'warning' },
      keyEvidence: [], businessImpact: [], recommendedActions: [], navigationLinks: [], dataLimitations: [], reviewCards: [], followUpQuestions: [],
      supplementalKnowledge: { title: 'Supporting policy', summary: 'Supplier contacts are required. [2]', rag: { mode: 'retrieved_excerpts', citations: [{ id: 'p2', documentId: 'guide', title: 'Company policy', heading: 'Company Policy › Supplier records', position: 1, sourceNumber: 2, excerpt: 'Supplier contacts are required.' }] } },
    } });
  });
  await page.route('**/api/ai-runtime/knowledge/guide', route => route.fulfill({ json: { title: 'Company policy', chunks: [{ id: 'p1', position: 0, content: 'Introduction.', heading: 'Company Policy' }, { id: 'p2', position: 1, content: 'Supplier contacts are required.', heading: 'Company Policy › Supplier records' }] } }));
  await openAssistant(page);
  await page.getByTestId('ai-assistant-input').fill('Which records are incomplete according to company policy?');
  await page.getByTestId('ai-assistant-send').click();
  await expect(page.getByTestId('ai-assistant-panel')).toContainText('Business records checked');
  const answer = page.getByTestId('ai-knowledge-answer');
  await expect(answer).toContainText('Supporting policy');
  await answer.locator('summary').click();
  await expect(answer.locator('summary')).toContainText('[2]');
  // The citation names its section instead of a passage number.
  await expect(answer.locator('summary')).toContainText('Company policy · Company Policy › Supplier records');
  await answer.getByRole('button', { name: 'Open cited passage' }).click();
  const source = page.getByRole('dialog', { name: 'Source document' });
  await expect(source.locator('[data-cited="true"]')).toContainText('Supplier contacts are required.');
  await expect(source.locator('[data-cited="true"]')).toContainText('Passage 2 · Company Policy › Supplier records');
  await page.keyboard.press('Escape');
  await expect(source).not.toBeVisible();
});

test('a no-answer says the documents do not answer and lists the searched passages, not as cited', async ({ page }) => {
  await page.route('**/api/ai-runtime/respond', route => route.fulfill({ json: {
    version: 'v2', intent: 'knowledge_retrieval', query: 'What is our approval limit for supplier invoices?', scope: { module: 'ai', dataScopeLabel: 'Accessible workspace documents' },
    conclusion: { title: 'Not answered by your documents', summary: 'The documents you can access do not answer this question. The passages that were searched are listed below.', severity: 'info', confidence: 'medium' },
    keyEvidence: [], businessImpact: [], recommendedActions: [], navigationLinks: [], dataLimitations: [], reviewCards: [], followUpQuestions: [],
    rag: { mode: 'no_answer', citations: [{ id: 'p2', documentId: 'guide', title: 'Company policy', heading: 'Company Policy › Supplier records', position: 1, sourceNumber: 1, excerpt: 'Supplier contacts are required.' }] },
  } }));
  await page.route('**/api/ai-runtime/knowledge/guide', route => route.fulfill({ json: { title: 'Company policy', chunks: [{ id: 'p1', position: 0, content: 'Introduction.', heading: 'Company Policy' }, { id: 'p2', position: 1, content: 'Supplier contacts are required.', heading: 'Company Policy › Supplier records' }] } }));
  await openAssistant(page);
  await page.getByTestId('ai-assistant-input').fill('What is our approval limit for supplier invoices?');
  await page.getByTestId('ai-assistant-send').click();
  const answer = page.getByTestId('ai-knowledge-answer');
  await expect(answer).toContainText('Not answered by your documents');
  await expect(answer).toContainText('do not answer this question');
  // Not the "model unavailable" excerpt banner: a model answered, and said the documents are silent.
  await expect(answer).not.toContainText('A model is not configured');
  await answer.locator('summary').click();
  await answer.getByRole('button', { name: 'Open passage', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Source document' });
  await expect(source.locator('[data-cited="true"]')).toContainText('Passage 2 · Company Policy › Supplier records · Searched passage');
  await expect(source).not.toContainText('Cited passage');
});
