/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Classify the complete source-derived refusal-code census so a new code cannot silently escape Stage 3 review and a retired code cannot leave stale remedy policy behind.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Extend the census across tracked production JavaScript, JSX, MJS, TypeScript and TSX; distinguish three internal UI/fallback reason tokens as explicit non-refusal lexical hits.
 */

/** The six Stage 3 review outcomes. Only operator-remediable entries belong in the remedy catalog. */
export type RefusalDisposition =
  | 'operator-remediable'
  | 'hard-security'
  | 'validation-or-user-action'
  | 'workflow-or-domain'
  | 'infrastructure-undetermined'
  | 'non-refusal';

/**
 * Source-census-locked refusal classifications.
 *
 * `infrastructure-undetermined` means the stable code currently aliases more than one root cause,
 * or no single exact operator control is proven at every call site. `non-refusal` records a lexical
 * census hit that is not an emitted refusal code, so the exception remains explicit and reviewable.
 */
export const REFUSAL_CODES_BY_DISPOSITION = Object.freeze({
  'operator-remediable': Object.freeze([
    'authorization_recorded_delegation_required',
    'database_pool_unavailable',
    'encrypted_secret_storage_required',
    'graph_engine_unavailable',
    'guest_unavailable',
    'intake_unavailable',
    'live_codex_auth_path_required',
    'vision_unavailable',
  ] as const),
  'hard-security': Object.freeze([
    'access_review_identity_required',
    'access_review_subject_denied',
    'app_access_denied',
    'app_access_identity_required',
    'authorization_app_admin_required',
    'authorization_execution_identity_required',
    'authorization_executor_scope_denied',
    'authorization_identity_required',
    'authorization_management_delegation_denied',
    'authorization_management_denied',
    'authorization_permission_denied',
    'authorization_queue_provenance_required',
    'authorization_queued_protected_shape_required',
    'authorization_remote_dispatch_required',
    'authorization_remote_hosted_reasoning_required',
    'authorization_result_identity_required',
    'authorization_service_admin_required',
    'authorization_service_owner_required',
    'authorization_tenant_denied',
    'authorization_tier_denied',
    'briefing_access_denied',
    'briefing_identity_required',
    'delegation_forbidden',
    'delegation_required',
    'embedded_tool_denied',
    'guest_blocked',
    'legacy_service_identity_not_allowed',
    'operator_required',
    'package_tool_identity_required',
    'package_tool_permission_denied',
    'private_org_named_member_required',
    'protected_result_identity_unavailable',
    'protected_result_lineage_required',
    'protected_result_owner_issuer_required',
    'public_tenant_profile_forbidden',
    'raw_audio_not_allowed',
    'remote_execution_evidence_unavailable',
    'remote_execution_grant_evidence_unavailable',
    'remote_execution_identity_required',
    'remote_execution_machine_auth_required',
    'roster_administrator_required',
    'roster_identity_required',
    'roster_scope_denied',
    'same_origin_required',
    'speaker_forbidden',
    'speaker_self_assignment_required',
    'specialist_context_identity_required',
    'specialist_context_permission_denied',
    'superadmin_required',
    'tenant_membership_active_external_identity_required',
    'tenant_membership_admin_required',
    'trusted_service_user_sub_required',
    'trusted_speaker_profile_not_allowed',
  ] as const),
  'validation-or-user-action': Object.freeze([
    'authorization_service_class_required',
    'browser_speech_unavailable',
    'confirmation_required',
    'issuer_required',
    'json_required',
    'mic_denied',
    'model_required',
    'node_token_not_required',
    'op_not_allowed',
    'path_required',
    'profile_required',
    'reconnect_required',
    'rules_required',
    'sign_in_required',
    'size_required',
    'symbol_required',
    'totp_required',
    'twilio_message_required',
    'twilio_user_required',
    'two_people_required',
  ] as const),
  'workflow-or-domain': Object.freeze([
    'approval_required',
    'authorization_approval_required',
    'book_delete_refused',
    'briefing_source_unavailable',
    'document_unavailable',
    'engine_refused',
    'fallback_required',
    'guardrail_blocked',
    'live_blocked',
    'operator_review_required',
    'package_tool_proposal_unavailable',
    'package_tool_result_unavailable',
    'package_tool_session_unavailable',
    'person_model_unavailable',
    'remote_execution_phase_refused',
    'remote_execution_result_unavailable',
    'settlement_blocked',
    'unspecified_approval_required',
  ] as const),
  'infrastructure-undetermined': Object.freeze([
    'access_review_unavailable',
    'ambient_fixture_unavailable',
    'ambient_unavailable',
    'analyst_unavailable',
    'app_access_unavailable',
    'artifact_authorization_unavailable',
    'audit_unavailable',
    'authorization_app_unavailable',
    'authorization_bot_posture_unavailable',
    'authorization_bot_transport_unavailable',
    'authorization_catalog_migration_required',
    'authorization_directory_unavailable',
    'authorization_ownership_unavailable',
    'authorization_replay_unavailable',
    'authorization_resource_adapter_unavailable',
    'authorization_result_persistence_required',
    'authorization_service_unavailable',
    'authorization_unavailable',
    'bot_unavailable',
    'briefings_unavailable',
    'delegation_replay_unavailable',
    'delegation_verification_unavailable',
    'enrollment_unavailable',
    'facebook_encrypted_storage_required',
    'identity_bridge_unavailable',
    'package_test_image_unavailable',
    'package_test_preflight_unavailable',
    'package_tool_registry_unavailable',
    'package_tool_unavailable',
    'prefs_unavailable',
    'principal_directory_unavailable',
    'protected_result_unavailable',
    'refusal_ledger_unavailable',
    'remote_execution_app_unavailable',
    'remote_execution_unavailable',
    'remote_task_journal_unavailable',
    'revocation_unavailable',
    'rotation_unavailable',
    'roster_unavailable',
    'speaker_audio_admission_unavailable',
    'speaker_service_unavailable',
    'speaker_sidecar_unavailable',
    'specialist_context_unavailable',
    'tenant_membership_unavailable',
    'twilio_connection_unavailable',
    'twilio_sender_unavailable',
    'visual_unavailable',
    'workspace_navigation_unavailable',
  ] as const),
  'non-refusal': Object.freeze([
    'abort_unavailable',
    'speaker_unavailable',
    'sse_unavailable',
    'sweep_refused',
  ] as const),
} as const satisfies Readonly<Record<RefusalDisposition, readonly string[]>>);

/** Every reviewed token, including an explicit lexical false positive. */
export type ClassifiedRefusalCode =
  (typeof REFUSAL_CODES_BY_DISPOSITION)[RefusalDisposition][number];

/** Direct code-to-disposition lookup derived from the grouped review inventory. */
export const REFUSAL_CODE_CLASSIFICATION: Readonly<Record<ClassifiedRefusalCode, RefusalDisposition>> = Object.freeze(
  Object.fromEntries(Object.entries(REFUSAL_CODES_BY_DISPOSITION).flatMap(([disposition, codes]) =>
    codes.map(code => [code, disposition]))) as Record<ClassifiedRefusalCode, RefusalDisposition>,
);
