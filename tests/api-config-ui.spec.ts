import { test, expect } from '@playwright/test';

// ============================================================
// 1. FUNCTIONALITY — Features work as expected
// ============================================================

test.describe('Functionality — UI features work correctly', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat.html');
  });

  test('page loads with all essential elements', async ({ page }) => {
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('#plan-provider')).toBeVisible();
    await expect(page.locator('#plan-model')).toBeVisible();
    // act-provider exists but is hidden when plan mode is active (correct behavior)
    await expect(page.locator('#act-provider')).toBeAttached();
    await expect(page.locator('#max-tokens')).toBeVisible();
    await expect(page.locator('#temperature')).toBeVisible();
  });

  test('mode toggle switches between Plan and Act', async ({ page }) => {
    const planBtn = page.locator('.mode-btn[data-mode="plan"]');
    const actBtn = page.locator('.mode-btn[data-mode="act"]');

    // Plan mode is default
    await expect(planBtn).toHaveClass(/active/);
    await expect(page.locator('#plan-config')).toHaveClass(/active/);

    // Switch to Act mode
    await actBtn.click();
    await expect(actBtn).toHaveClass(/active/);
    await expect(planBtn).not.toHaveClass(/active/);
    await expect(page.locator('#act-config')).toHaveClass(/active/);
    await expect(page.locator('#plan-config')).not.toHaveClass(/active/);

    // Switch back to Plan mode
    await planBtn.click();
    await expect(planBtn).toHaveClass(/active/);
    await expect(page.locator('#plan-config')).toHaveClass(/active/);
  });

  test('provider dropdown populates model dropdown', async ({ page }) => {
    const providerSelect = page.locator('#plan-provider');
    const modelSelect = page.locator('#plan-model');

    // Initially no models
    const initialOptions = await modelSelect.locator('option').count();
    expect(initialOptions).toBe(1); // Just "Select model..."

    // Select Anthropic
    await providerSelect.selectOption('anthropic');

    // Models should be populated
    const modelOptions = await modelSelect.locator('option').count();
    expect(modelOptions).toBeGreaterThan(1);
  });

  test('provider info updates on selection', async ({ page }) => {
    const providerSelect = page.locator('#plan-provider');
    const providerInfo = page.locator('#plan-provider-info');

    // Initially empty
    await expect(providerInfo).toHaveText('');

    // Select a provider
    await providerSelect.selectOption('anthropic');
    await expect(providerInfo).not.toHaveText('');
    await expect(providerInfo).toContainText('Anthropic');
  });

  test('save configuration writes to localStorage', async ({ page }) => {
    // Select a provider and model
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');

    // Click save
    await page.getByRole('button', { name: /save/i }).click();

    // Verify localStorage
    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    expect(saved).not.toBeNull();
    const config = JSON.parse(saved!);
    expect(config.planModeApiProvider).toBe('anthropic');
    expect(config.planModeApiModelId).toBe('claude-sonnet-4-6');
  });

  test('clear configuration removes data', async ({ page }) => {
    // Save first
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.getByRole('button', { name: /save/i }).click();

    // Set up dialog handler to accept confirm
    page.on('dialog', dialog => dialog.accept());

    // Clear
    await page.getByRole('button', { name: /clear/i }).click();

    // Verify localStorage is cleared
    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    expect(saved).toBeNull();
  });

  test('output log displays messages', async ({ page }) => {
    const output = page.locator('#output');
    await expect(output).toBeVisible();

    // Selecting a provider should log
    await page.locator('#plan-provider').selectOption('anthropic');
    await expect(output).toContainText('anthropic');
  });
});

// ============================================================
// 2. FUNCTIONAL CORRECTNESS — Business logic is accurate
// ============================================================

test.describe('Functional Correctness — Business logic is accurate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat.html');
  });

  test('all 40 providers are available in dropdowns', async ({ page }) => {
    const options = await page.locator('#plan-provider option').allTextContents();
    // Subtract 1 for the "Select provider..." placeholder
    const providerCount = options.length - 1;
    expect(providerCount).toBe(40);
    expect(options).toContain('Anthropic');
  });

  test('Anthropic models match expected list', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('anthropic');
    const models = await page.locator('#plan-model option').allTextContents();
    // Filter out placeholder
    const modelNames = models.filter(m => m !== 'Select model...');
    expect(modelNames.length).toBeGreaterThanOrEqual(6);
    expect(modelNames.some(m => m.includes('Sonnet'))).toBeTruthy();
    expect(modelNames.some(m => m.includes('Opus'))).toBeTruthy();
  });

  test('Plan and Act modes maintain separate configurations', async ({ page }) => {
    // Set plan provider
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');

    // Switch to Act and set different provider
    await page.locator('.mode-btn[data-mode="act"]').click();
    await page.locator('#act-provider').selectOption('openrouter');

    // Save
    await page.getByRole('button', { name: /save/i }).click();

    // Verify both are saved separately
    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    const config = JSON.parse(saved!);
    expect(config.planModeApiProvider).toBe('anthropic');
    expect(config.actModeApiProvider).toBe('openrouter');
    expect(config.planModeApiModelId).toBe('claude-sonnet-4-6');
  });

  test('advanced settings save correct values', async ({ page }) => {
    await page.locator('#max-tokens').fill('16384');
    await page.locator('#temperature').fill('0.3');

    await page.getByRole('button', { name: /save/i }).click();

    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    const config = JSON.parse(saved!);
    expect(config.maxTokens).toBe(16384);
    expect(config.temperature).toBe(0.3);
  });

  test('default values are sensible', async ({ page }) => {
    const maxTokens = await page.locator('#max-tokens').inputValue();
    const temperature = await page.locator('#temperature').inputValue();
    expect(parseInt(maxTokens)).toBe(8192);
    expect(parseFloat(temperature)).toBe(0.7);
  });

  test('changing provider resets model selection', async ({ page }) => {
    // Select provider and model
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');

    // Change provider
    await page.locator('#plan-provider').selectOption('openai');

    // Model should be reset (no model selected)
    const selectedModel = await page.locator('#plan-model').inputValue();
    expect(selectedModel).toBe('');
  });
});

// ============================================================
// 3. TECHNICAL CORRECTNESS — Implementation is sound
// ============================================================

test.describe('Technical Correctness — Implementation is sound', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui.html');
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/ui.html');
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test('localStorage handles JSON correctly', async ({ page }) => {
    // Save config
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');
    await page.getByRole('button', { name: /save/i }).click();

    // Verify it's valid JSON
    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    expect(() => JSON.parse(saved!)).not.toThrow();
  });

  test('UI script loads without errors', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', error => jsErrors.push(error.message));

    await page.goto('/ui.html');
    await page.waitForTimeout(500);
    expect(jsErrors).toHaveLength(0);
  });

  test('all provider dropdowns have the same options', async ({ page }) => {
    const planOptions = await page.locator('#plan-provider option').allTextContents();
    const actOptions = await page.locator('#act-provider option').allTextContents();
    expect(planOptions).toEqual(actOptions);
  });

  test('model dropdown is empty when no provider selected', async ({ page }) => {
    const modelOptions = await page.locator('#plan-model option').allTextContents();
    expect(modelOptions).toEqual(['Select provider first...']);
  });

  test('provider-specific secret inputs are password type', async ({ page }) => {
    // Select AWS Bedrock which has password fields
    await page.locator('#plan-provider').selectOption('bedrock');

    const passwordInputs = page.locator('#plan-provider-config input[type="password"]');
    const count = await passwordInputs.count();
    expect(count).toBeGreaterThanOrEqual(2); // access key + secret key
  });

  test('configuration persists across page reloads', async ({ page }) => {
    // Set and save config
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');
    await page.getByRole('button', { name: /save/i }).click();

    // Reload page
    await page.reload();
    await page.waitForTimeout(600); // Wait for auto-load

    // Verify values persisted
    const provider = await page.locator('#plan-provider').inputValue();
    expect(provider).toBe('anthropic');
  });
});

// ============================================================
// 4. PROVIDER-SPECIFIC FIELDS — Config accuracy per provider
// ============================================================

test.describe('Provider-Specific Fields — Config accuracy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui.html');
  });

  test('Anthropic shows API key and base URL fields', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('anthropic');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('input[type="password"]')).toHaveCount(1); // API key
    await expect(configSection.locator('[data-config-key="anthropicBaseUrl"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="apiKey"]')).toBeAttached();
  });

  test('Claude Code shows CLI path (no API key)', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('claude-code');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('[data-config-key="claudeCodePath"]')).toBeAttached();
    // No password fields — Claude Code uses CLI auth
    await expect(configSection.locator('input[type="password"]')).toHaveCount(0);
  });

  test('AWS Bedrock shows region, access key, secret key, and profile fields', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('bedrock');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('[data-config-key="awsRegion"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="awsAccessKey"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="awsSecretKey"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="awsSessionToken"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="awsProfile"]')).toBeAttached();
    // Checkboxes
    await expect(configSection.locator('[data-config-key="awsUseCrossRegionInference"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="awsUseProfile"]')).toBeAttached();
  });

  test('LM Studio shows base URL (no API key)', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('lmstudio');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('[data-config-key="lmStudioBaseUrl"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="lmStudioModelId"]')).toBeAttached();
    // No password fields
    await expect(configSection.locator('input[type="password"]')).toHaveCount(0);
  });

  test('Ollama shows base URL and model ID', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('ollama');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('[data-config-key="ollamaBaseUrl"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="ollamaModelId"]')).toBeAttached();
    await expect(configSection.locator('[data-config-key="ollamaApiOptionsCtxNum"]')).toBeAttached();
  });

  test('changing provider updates config fields', async ({ page }) => {
    // Select Anthropic
    await page.locator('#plan-provider').selectOption('anthropic');
    await expect(page.locator('#plan-provider-config [data-config-key="apiKey"]')).toBeAttached();

    // Change to Claude Code
    await page.locator('#plan-provider').selectOption('claude-code');
    await expect(page.locator('#plan-provider-config [data-config-key="claudeCodePath"]')).toBeAttached();
    // Anthropic API key field should be gone
    await expect(page.locator('#plan-provider-config [data-config-key="apiKey"]')).not.toBeAttached();
  });

  test('provider-specific fields save to localStorage', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('gemini');

    await page.locator('#plan-geminiApiKey').fill('test-gemini-key');

    await page.getByRole('button', { name: /save/i }).click();

    const saved = await page.evaluate(() => localStorage.getItem('clineApiConfig'));
    const config = JSON.parse(saved!);
    expect(config.plan_geminiApiKey).toBe('test-gemini-key');
  });

  test('VS Code LM shows model selector (no API key)', async ({ page }) => {
    await page.locator('#plan-provider').selectOption('vscode-lm');

    const configSection = page.locator('#plan-provider-config');
    await expect(configSection.locator('[data-config-key="vsCodeLmModelSelector"]')).toBeAttached();
    await expect(configSection.locator('input[type="password"]')).toHaveCount(0);
  });
});

// ============================================================
// 5. API SERVER & FILESYSTEM PERSISTENCE
// ============================================================

test.describe('API Server & Filesystem Persistence', () => {
  test('API status endpoint returns server info', async ({ request }) => {
    const response = await request.get('/api/status');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.outputDir).toBeTruthy();
    expect(data.writeMode).toBeTruthy();
  });

  test('save configuration to filesystem via API', async ({ request }) => {
    await request.delete('/api/config');
    const config = {
      mode: 'plan',
      planModeApiProvider: 'anthropic',
      planModeApiModelId: 'claude-sonnet-4-6',
      maxTokens: 8192,
      temperature: 0.7,
    };
    const response = await request.post('/api/config', { data: config });
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.mode).toBe('split');
    expect(result.files).toBeDefined();
    expect(result.settingsCount).toBeGreaterThan(0);
  });

  test('load configuration from filesystem via API', async ({ request }) => {
    await request.delete('/api/config');
    await request.post('/api/config', {
      data: { planModeApiProvider: 'openai', planModeApiModelId: 'gpt-4o' },
    });
    const response = await request.get('/api/config');
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.config.planModeApiProvider).toBe('openai');
    expect(result.config.planModeApiModelId).toBe('gpt-4o');
  });

  test('clear configuration files via API', async ({ request }) => {
    await request.post('/api/config', { data: { mode: 'act' } });
    const response = await request.delete('/api/config');
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.cleared).toBe(true);
    const loadResponse = await request.get('/api/config');
    const loadResult = await loadResponse.json();
    expect(Object.keys(loadResult.config).length).toBe(0);
  });

  test('secrets separated from settings in split mode', async ({ request }) => {
    await request.delete('/api/config');
    const config = {
      planModeApiProvider: 'anthropic',
      plan_apiKey: 'sk-test-secret-key',
      plan_anthropicBaseUrl: 'https://api.anthropic.com',
    };
    const response = await request.post('/api/config', { data: config });
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.secretsCount).toBeGreaterThanOrEqual(1);
    expect(result.settingsCount).toBeGreaterThanOrEqual(1);
  });

  test('end-to-end: UI save persists to filesystem', async ({ page }) => {
    await page.goto('/ui.html');
    await page.locator('#plan-provider').selectOption('anthropic');
    await page.locator('#plan-model').selectOption('claude-sonnet-4-6');
    await page.getByRole('button', { name: /save/i }).click();
    await page.waitForTimeout(500);
    const response = await page.request.get('/api/config');
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.config.planModeApiProvider).toBe('anthropic');
    expect(result.config.planModeApiModelId).toBe('claude-sonnet-4-6');
  });
});
