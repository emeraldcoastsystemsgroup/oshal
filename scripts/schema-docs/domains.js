/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Reading-order grouping of CORE Postgres tables into domain pages for the schema docs. Grouping is presentation only - it changes no table and asserts no ownership (ownership comes from the source scan). First matching rule wins; a core table no rule matches lands on the "Other" page, which the generator reports so the map is extended rather than silently lossy.
 */

'use strict';

/**
 * Ordered domain rules. `match` is tested against the table name. Order matters: specific
 * families come before the broad ones that would otherwise swallow them.
 */
const CORE_DOMAINS = [
  {
    slug: 'tickets-and-work', title: 'Tickets, work & runs',
    blurb: 'The ticket queue, work items, workspaces, swarm and workflow runs, subtask lifecycle, Jarvis tasks and brief deliveries, the remote-task journal and apply runs.',
    match: /^(tickets|ticket_.*|work_items|workspaces|task_checkpoints|subtask_lifecycle_.*|swarm_runs|swarm_escalations|workflow_runs?|workflow_run_steps|oshal_queue_dlq|jarvis_.*|test_lab_golden_runs|apply_runs|apply_task_capabilities|remote_task_journal_.*)$/,
  },
  {
    slug: 'agents-and-tools', title: 'Agents, personas & tools',
    blurb: 'Bot identities and their configuration, persona layers, roles and presets, the tool registry and its approvals, routing audit, A2A agents and shared node leases.',
    match: /^(agents|agent_config|agent_tools|persona_layers|swarm_roles|swarm_presets|tools|tool_.*|runtime_tool_executors|routing_audit_log|a2a_agents|config_snapshots|config_sync_log|oshal_node_resource_leases|oshal_workload_identities|oshal_user_delegations)$/,
  },
  {
    slug: 'apps-and-platform', title: 'Apps & platform bookkeeping',
    blurb: 'Installed applications, app registries and access tiers, and the two migration ledgers (core and package).',
    match: /^(swarm_applications|app_migrations|app_package_migrations|app_registries|oshal_app_access)$/,
  },
  {
    slug: 'identity-and-access', title: 'Identity, access & preferences',
    blurb: 'Tenants and memberships, local and federated identities, CLI and TV tokens, channel links, and per-user preferences.',
    match: /^(oshal_tenants|oshal_tenant_memberships|oshal_local_users|oshal_external_identity_links|oshal_cli_tokens|tv_token_revocations|channel_links|channel_link_codes|user_preferences|user_notification_prefs|voice_user_prefs|oshal_storage_prefs|oshal_user_llm_prefs)$/,
  },
  {
    slug: 'connectors', title: 'Connectors, credentials & intake',
    blurb: 'Connector accounts and their encrypted credentials, per-user enablement, action audit, webhook deliveries, and the inbox / feed / intake cursors that pull external data in.',
    match: /^(oshal_connections|oshal_connector_user_enablement|oshal_user_deks|connector_action_audit|oshal_webhook_deliveries|ats_site_credentials|oshal_intake_cursors|oshal_inbox_cursor|oshal_inbox_messages|feed_messages|feed_settings)$/,
  },
  {
    slug: 'cost-and-usage', title: 'Chat, cost & model usage',
    blurb: 'Chat tasks and messages (the canonical per-call cost ledger), cost events, budgets, free-tier state, remote cost receipts, Token Chase, optimisation and evaluation records.',
    match: /^(chat_tasks|chat_messages|oshal_cost_events|oshal_budgets|oshal_budget_events|oshal_free_tier_state|remote_task_cost_receipts|token_chase_.*|optimize_configs|eval_runs|human_feedback)$/,
  },
  {
    slug: 'security-and-audit', title: 'Security & audit',
    blurb: 'The append-only access audit log, data-lifecycle audit, and security-center scans and findings.',
    match: /^(access_audit_log|data_lifecycle_audit|oshal_security_findings|oshal_security_scans)$/,
  },
  {
    slug: 'alerts-and-incidents', title: 'Alerts, incidents & topology',
    blurb: 'Alert-pipeline events, envelopes, dispatches and dead letters; incidents with their members and snapshots; the service topology graph; RCA reservations and batch-job telemetry.',
    match: /^(oshal_alert_.*|oshal_incident.*|oshal_topology_.*|oshal_rca_reservation|oshal_batch_job_runs)$/,
  },
  {
    slug: 'memory-and-knowledge', title: 'Memory, knowledge & user model',
    blurb: 'Agent and swarm memory, knowledge documents, pgvector RAG chunks, the personal graph, the user model and person model, and visual response artifacts.',
    match: /^(agent_memories|knowledge_memory_documents|oshal_swarm_memory|rag_chunks|personal_graph_.*|user_model_.*|person_model_.*|haven_.*|home_context|household_.*|open_threads|linked_integrations|connected_devices|visual_response_artifacts)$/,
  },
  {
    slug: 'ambient-and-spatial', title: 'Ambient listening, speakers & spatial',
    blurb: 'Ambient transcript capture, speaker diarization and consent, per-person enrichment, and spatial scans.',
    match: /^(ambient_.*|spatial_scans)$/,
  },
  {
    slug: 'trading', title: 'Trading & markets',
    blurb: 'Trading accounts and books, orders, signals, decisions and predictions, risk guards, the strategy lab, market bars and the Kalshi forward test.',
    match: /^(oshal_trading_.*|trading_.*|market_bars|kalshi_.*)$/,
  },
  {
    slug: 'media-and-content', title: 'Media, content & social',
    blurb: 'Content studio articles and drafts, social and LinkedIn drafts, and the video series / pump / vids job tables.',
    match: /^(oshal_content_.*|social_content_drafts|linkedin_profile_plans|video_.*|vids_jobs)$/,
  },
  {
    slug: 'travel-and-props', title: 'Travel & pumpkin prop',
    blurb: 'Tables for the travel experience (migration 050) and the pumpkin prop (migration 084) that core migrations create.',
    match: /^(travel_.*|pumpkin_.*)$/,
  },
];

const OTHER_DOMAIN = { slug: 'other', title: 'Other core tables', blurb: 'Core tables no domain rule matches yet.' };

/**
 * @description Pick the domain page a core table belongs on.
 * @param {string} table - table name
 * @returns {{slug: string, title: string, blurb: string}} the first matching domain, else "Other"
 */
function domainFor(table) {
  return CORE_DOMAINS.find((d) => d.match.test(table)) || OTHER_DOMAIN;
}

module.exports = { CORE_DOMAINS, OTHER_DOMAIN, domainFor };
