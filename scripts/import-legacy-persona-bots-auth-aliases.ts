/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted legacy authorization key alias map for persona bot import to keep script file under size constraints
 */

/**
 * @description Maps legacy persona authorization keys to normalized tool names.
 */
export const AUTHORIZATION_TOOL_ALIASES: Record<string, string[]> = {
  aws_cli: ['aws-cli'],
  kubectl: ['kubectl'],
  gcloud: ['gcloud'],
  docker: ['docker'],
  google_search: ['google-search'],
  web_search: ['google-search'],
  chroma_mcp: ['rag-query', 'rag-ingestion', 'knowledge-enhancement'],
  plane_mcp: ['plane-mcp'],
  bash: ['bash'],
  command_execution: ['bash'],
  fetch: ['fetch', 'curl'],
  read_file: ['read-file'],
  write_file: ['write-file'],
  file_read: ['read-file'],
  file_write: ['write-file'],
  filesystem: ['filesystem'],
  browser: ['browser'],
  tool_use: ['cline'],
  workflow_studio: ['workflow-studio'],
};
