/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Centralized repeatable tool runtime field specifications so UI rendering and activation validation share the same config contract
 */

const TOOL_RUNTIME_FIELD_SPECS = {
  presentron: [
    {
      label: 'Service URL',
      path: 'endpoint.url',
      type: 'url',
      placeholder: 'http://presentron:8080',
      required: true,
      helpText: 'Required for Presentron health checks, generation, and header workspace visibility.',
    },
    {
      label: 'Presentron MCP URL',
      path: 'metadata.mcpUrl',
      type: 'url',
      placeholder: 'http://presentron-mcp:8081',
      required: false,
      helpText: 'Optional separate MCP endpoint when the Presentron API service and Presentron MCP server are deployed at different URLs.',
    },
    {
      label: 'Health Path',
      path: 'metadata.healthcheckPath',
      type: 'text',
      placeholder: '/health',
      required: false,
      helpText: 'Optional override for the service health route.',
    },
  ],
};

/**
 * @description Returns repeatable runtime field specs for a tool.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @returns {Array<Record<string, unknown>>} Ordered field specs.
 */
export function getToolRuntimeFieldSpecs(tool) {
  const toolName = readString(tool?.tool?.name || tool?.name);
  return Array.isArray(TOOL_RUNTIME_FIELD_SPECS[toolName]) ? TOOL_RUNTIME_FIELD_SPECS[toolName] : [];
}

/**
 * @description Returns required field labels missing from a tool runtime config.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @param {Record<string, unknown>} config Effective normalized config.
 * @returns {string[]} Missing required runtime labels.
 */
export function getMissingRequiredToolRuntimeFields(tool, config) {
  return getToolRuntimeFieldSpecs(tool)
    .filter((field) => field.required)
    .filter((field) => !readString(readConfigValue(config, field.path)))
    .map((field) => readString(field.label) || readString(field.path));
}

/**
 * @description Renders runtime field inputs declared by the centralized tool config specs.
 * @param {{ tool: Record<string, unknown>, config: Record<string, unknown>, escapeHtml: (value: string) => string }} params Render parameters.
 * @returns {string} Runtime field HTML string.
 */
export function renderToolRuntimeFields(params) {
  const specs = getToolRuntimeFieldSpecs(params.tool);
  if (specs.length === 0) {
    return '';
  }

  return specs.map((field) => buildRuntimeField(params.tool, params.config, field, params.escapeHtml)).join('');
}

function buildRuntimeField(tool, config, field, escapeHtml) {
  const toolId = escapeHtml(readString(tool?.toolId));
  const path = readString(field.path);
  const label = readString(field.label);
  const placeholder = readString(field.placeholder);
  const helpText = readString(field.helpText);
  const value = readString(readConfigValue(config, path));
  const inputType = readString(field.type) || 'text';
  const requiredMarker = field.required ? ' *' : '';
  const helpMarkup = helpText ? `<span class="tool-field-help">${escapeHtml(helpText)}</span>` : '';

  return `
    <div class="tool-config-field${field.wide ? ' tool-config-field-wide' : ''}">
      <label>${escapeHtml(label + requiredMarker)}</label>
      <input
        class="config-input"
        type="${escapeHtml(inputType)}"
        value="${escapeHtml(value)}"
        placeholder="${escapeHtml(placeholder)}"
        data-tool-id="${toolId}"
        data-config-path="${escapeHtml(path)}"
      />
      ${helpMarkup}
    </div>
  `;
}

function readConfigValue(config, path) {
  return path.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return '';
    }
    return current[segment];
  }, config);
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
