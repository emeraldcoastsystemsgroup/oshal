/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright tests for Layer 1 Tools Framework - Tool Registry
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | API_BASE follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456 (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import { baseOrigin } from './helpers';

/**
 * @description E2E tests for the Tool Registry API endpoints.
 * Tests CRUD operations, filtering, search, and metadata endpoints.
 */

const API_BASE = baseOrigin();
const TOOLS_ENDPOINT = `${API_BASE}/api/tools`;

test.describe('Tool Registry API', () => {
  test.beforeAll(async () => {
    // TODO: Run database migration before tests
    // await exec('psql -d oshal_test -f scripts/migrations/002-layer1-tools-framework.sql');
  });

  test('should retrieve all tools', async ({ request }) => {
    const response = await request.get(TOOLS_ENDPOINT);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('tools');
    expect(Array.isArray(data.tools)).toBeTruthy();
  });

  test('should create a new tool', async ({ request }) => {
    const newTool = {
      name: 'test-tool-kubectl',
      type: 'cli',
      displayName: 'Kubernetes CLI',
      description: 'Command-line tool for Kubernetes cluster management',
      category: 'devops',
      installSpec: {
        method: 'binary',
        command: 'curl -LO https://dl.k8s.io/release/stable.txt',
        verifyCommand: 'kubectl version --client',
      },
      skills: ['kubernetes', 'cluster-management', 'container-orchestration'],
      selectorFragment: 'Kubernetes cluster operations and kubectl commands',
      routingTags: ['kubernetes', 'k8s', 'kubectl', 'containers'],
      authGroup: 'kubernetes',
      defaultAuthMode: 'ask',
    };

    const response = await request.post(TOOLS_ENDPOINT, {
      data: newTool,
    });
    
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('tool');
    expect(data.tool.name).toBe(newTool.name);
    expect(data.tool.type).toBe(newTool.type);
    expect(data.tool).toHaveProperty('toolId');
  });

  test('should reject duplicate tool names', async ({ request }) => {
    const tool = {
      name: 'test-tool-duplicate',
      type: 'cli',
      displayName: 'Duplicate Test',
      description: 'Tool for testing duplicate name validation',
      category: 'test',
    };

    // Create first tool
    await request.post(TOOLS_ENDPOINT, { data: tool });

    // Attempt to create duplicate
    const response = await request.post(TOOLS_ENDPOINT, { data: tool });
    expect(response.status()).toBe(400);
  });

  test('should retrieve tool by ID', async ({ request }) => {
    // Create a tool first
    const createResponse = await request.post(TOOLS_ENDPOINT, {
      data: {
        name: 'test-tool-getbyid',
        type: 'cli',
        displayName: 'Get By ID Test',
        description: 'Tool for testing get by ID',
        category: 'test',
      },
    });
    const { tool } = await createResponse.json();

    // Retrieve by ID
    const response = await request.get(`${TOOLS_ENDPOINT}/${tool.toolId}`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data.tool.toolId).toBe(tool.toolId);
    expect(data.tool.name).toBe('test-tool-getbyid');
  });

  test('should update tool', async ({ request }) => {
    // Create a tool first
    const createResponse = await request.post(TOOLS_ENDPOINT, {
      data: {
        name: 'test-tool-update',
        type: 'cli',
        displayName: 'Update Test',
        description: 'Tool for testing update',
        category: 'test',
      },
    });
    const { tool } = await createResponse.json();

    // Update the tool
    const response = await request.put(`${TOOLS_ENDPOINT}/${tool.toolId}`, {
      data: {
        description: 'Updated description for testing',
        category: 'updated-category',
      },
    });
    
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.tool.description).toBe('Updated description for testing');
    expect(data.tool.category).toBe('updated-category');
  });

  test('should delete tool', async ({ request }) => {
    // Create a tool first
    const createResponse = await request.post(TOOLS_ENDPOINT, {
      data: {
        name: 'test-tool-delete',
        type: 'cli',
        displayName: 'Delete Test',
        description: 'Tool for testing deletion',
        category: 'test',
      },
    });
    const { tool } = await createResponse.json();

    // Delete the tool
    const deleteResponse = await request.delete(`${TOOLS_ENDPOINT}/${tool.toolId}`);
    expect(deleteResponse.ok()).toBeTruthy();

    // Verify deletion
    const getResponse = await request.get(`${TOOLS_ENDPOINT}/${tool.toolId}`);
    expect(getResponse.status()).toBe(404);
  });

  test('should filter tools by category', async ({ request }) => {
    const response = await request.get(`${TOOLS_ENDPOINT}?category=devops`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data.tools.every((tool: any) => tool.category === 'devops')).toBeTruthy();
  });

  test('should search tools', async ({ request }) => {
    const response = await request.get(`${TOOLS_ENDPOINT}/search?q=kubernetes`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('tools');
    expect(data).toHaveProperty('query', 'kubernetes');
  });

  test('should retrieve categories', async ({ request }) => {
    const response = await request.get(`${TOOLS_ENDPOINT}/metadata/categories`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('categories');
    expect(Array.isArray(data.categories)).toBeTruthy();
  });

  test('should retrieve auth groups', async ({ request }) => {
    const response = await request.get(`${TOOLS_ENDPOINT}/metadata/auth-groups`);
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('authGroups');
    expect(Array.isArray(data.authGroups)).toBeTruthy();
  });
});
