#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Initialize Plane Database with Minimal Setup
 * Creates workspace, project, admin user, states, and test ticket
 */

const { Client } = require('pg');
const crypto = require('crypto');

/**
 * @description Postgres connection settings for the Plane instance, resolved from
 * environment variables with local-Docker defaults so the script can run against a
 * dev stack out of the box while still being overridable in other environments.
 * @type {{host: string, port: number, database: string, user: string, password: string}}
 */
const dbConfig = {
  host: process.env.PLANE_DB_HOST || 'plane-plane-db-1',
  port: parseInt(process.env.PLANE_DB_PORT || '5432'),
  database: process.env.PLANE_DB_NAME || 'plane',
  user: process.env.PLANE_DB_USER || 'plane',
  password: process.env.PLANE_DB_PASSWORD || 'plane',
};

/**
 * @description Produces a fresh UUID for use as a primary key on the rows this
 * script inserts. Centralized so all generated identifiers share one source and
 * the underlying generator can be swapped without touching call sites.
 * @returns {string} A newly generated RFC 4122 v4 UUID.
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * @description Bootstraps a minimal but complete Plane data set so the
 * PlaneMonitorService and task-manager agent have something to operate on without
 * a manual UI walkthrough: it seeds an admin user, workspace, project, memberships,
 * workflow states, and a single assigned test ticket. Every insert is idempotent
 * (ON CONFLICT DO NOTHING) and re-reads the canonical id afterward, so the script
 * is safe to run repeatedly against an existing database. On any failure it logs
 * the error, closes the connection, and exits the process with a non-zero code.
 * @returns {Promise<{workspaceId: string, projectId: string, userId: string, ticketId: string}>}
 *   Resolves with the identifiers of the seeded workspace, project, admin user, and test ticket.
 */
async function initializePlane() {
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('✓ Connected to Plane database');

    // Create admin user with all required fields
    let userId = generateUUID(); // let instead of const so we can reassign after fetching
    const userEmail = 'admin';
    const username = 'admin';
    const password = 'pbkdf2_sha256$600000$dummyhashforlocaltesting';
    const avatar = '';
    const token = generateUUID();
    
    await client.query(`
      INSERT INTO users (
        id, email, username, password, avatar,
        first_name, last_name, display_name,
        date_joined, created_at, updated_at,
        last_location, created_location,
        is_superuser, is_managed, is_password_expired,
        is_active, is_staff, is_email_verified, is_password_autoset,
        token, user_timezone,
        last_login_ip, last_logout_ip, last_login_medium, last_login_uagent,
        is_bot, is_email_valid
      ) VALUES (
        $1, $2, $3, $4, $5,
        'Admin', 'User', 'Admin User',
        NOW(), NOW(), NOW(),
        '', '',
        true, false, false,
        true, true, false, false,
        $6, 'UTC',
        '', '', '', '',
        false, true
      )
      ON CONFLICT (email) DO NOTHING
    `, [userId, userEmail, username, password, avatar, token]);
    
    // Fetch the actual user ID (in case it already existed)
    const userResult = await client.query('SELECT id FROM users WHERE email = $1', [userEmail]);
    userId = userResult.rows[0].id;
    console.log(`✓ Created/found admin user: ${userEmail} (${userId})`);

    // Create workspace
    let workspaceId = generateUUID();
    const workspaceSlug = 'devopscloud-01';
    const workspaceName = 'DevOps Cloud 01';
    
    await client.query(`
      INSERT INTO workspaces (id, name, slug, owner_id, timezone, background_color, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'UTC', '#0d101b', NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
    `, [workspaceId, workspaceName, workspaceSlug, userId]);
    
    // Fetch actual workspace ID (in case it already existed)
    const workspaceResult = await client.query('SELECT id FROM workspaces WHERE slug = $1', [workspaceSlug]);
    workspaceId = workspaceResult.rows[0].id;
    console.log(`✓ Created/found workspace: ${workspaceName} (${workspaceId})`);

    // Add user to workspace
    await client.query(`
      INSERT INTO workspace_members (
        id, workspace_id, member_id, role, 
        view_props, default_props, issue_props, is_active,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 20, 
        '{}', '{}', '{}', true,
        NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `, [generateUUID(), workspaceId, userId]);
    console.log(`✓ Added admin to workspace`);

    // Create project with all required fields
    let projectId = generateUUID();
    const projectName = 'AI Lab Integration';
    const projectDescription = 'Test project for Plane integration with AI Lab task-manager agent';
    const projectIdentifier = 'AILAB';
    
    await client.query(`
      INSERT INTO projects (
        id, name, description, identifier, workspace_id, created_by_id,
        network, timezone,
        cycle_view, module_view, issue_views_view, page_view, intake_view,
        archive_in, close_in, logo_props,
        is_time_tracking_enabled, is_issue_type_enabled, guest_view_all_features,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        2, 'UTC',
        true, true, true, true, false,
        0, 0, '{}',
        false, false, false,
        NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `, [projectId, projectName, projectDescription, projectIdentifier, workspaceId, userId]);
    
    // Fetch actual project ID (in case it already existed)
    const projectResult = await client.query('SELECT id FROM projects WHERE identifier = $1 AND workspace_id = $2', [projectIdentifier, workspaceId]);
    projectId = projectResult.rows[0].id;
    console.log(`✓ Created/found project: ${projectName} (${projectId})`);

    // Add user to project
    await client.query(`
      INSERT INTO project_members (
        id, project_id, workspace_id, member_id, role,
        view_props, default_props, preferences, sort_order, is_active,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 20,
        '{}', '{}', '{}', 1.0, true,
        NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `, [generateUUID(), projectId, workspaceId, userId]);
    console.log(`✓ Added admin to project`);

    // Create states with all required fields
    const states = [
      { name: 'Todo', slug: 'todo', description: 'Tasks to be done', sequence: 1, group: 'backlog', color: '#3f76ff', default: true, is_triage: false },
      { name: 'In Progress', slug: 'in_progress', description: 'Tasks being worked on', sequence: 2, group: 'started', color: '#f59e0b', default: false, is_triage: false },
      { name: 'Customer Action', slug: 'customer_action', description: 'Awaiting customer response', sequence: 3, group: 'started', color: '#22c55e', default: false, is_triage: false },
      { name: 'Done', slug: 'done', description: 'Completed tasks', sequence: 4, group: 'completed', color: '#16a34a', default: false, is_triage: false }
    ];

    const stateIds = {};
    for (const state of states) {
      const stateId = generateUUID();
      await client.query(`
        INSERT INTO states (
          id, name, slug, description, sequence, "group", color,
          "default", is_triage,
          project_id, workspace_id, created_by_id,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9,
          $10, $11, $12,
          NOW(), NOW()
        )
        ON CONFLICT DO NOTHING
      `, [stateId, state.name, state.slug, state.description, state.sequence, state.group, state.color, state.default, state.is_triage, projectId, workspaceId, userId]);
      
      // Fetch actual state ID (in case it already existed)
      const stateResult = await client.query('SELECT id FROM states WHERE name = $1 AND project_id = $2', [state.name, projectId]);
      stateIds[state.name] = stateResult.rows[0].id;
      console.log(`✓ Created/found state: ${state.name} (${stateIds[state.name]})`);
    }

    // Create test ticket with all required fields
    const ticketId = generateUUID();
    const ticketName = `Test ticket for the operator - Integration Testing`;
    const ticketDescriptionText = 'This is a test ticket to validate PlaneMonitorService integration. The operator needs help testing the task-manager agent workflow.';
    const ticketDescriptionJson = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: ticketDescriptionText }]
      }]
    };
    const ticketDescriptionHtml = `<p>${ticketDescriptionText}</p>`;

    await client.query(`
      INSERT INTO issues (
        id, name, description, description_html, sequence_id,
        project_id, workspace_id, state_id, created_by_id,
        priority, sort_order, is_draft,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 1,
        $5, $6, $7, $8,
        'medium', 1.0, false,
        NOW(), NOW()
      )
      RETURNING id, name
    `, [ticketId, ticketName, JSON.stringify(ticketDescriptionJson), ticketDescriptionHtml, projectId, workspaceId, stateIds['Todo'], userId]);

    console.log(`✓ Created ticket: ${ticketId}`);
    console.log(`  Name: ${ticketName}`);

    // Assign to admin user
    await client.query(`
      INSERT INTO issue_assignees (id, issue_id, project_id, workspace_id, assignee_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    `, [generateUUID(), ticketId, projectId, workspaceId, userId]);

    console.log(`✓ Assigned to: ${userEmail}`);

    console.log('\n✅ Plane initialized successfully!');
    console.log(`Workspace: ${workspaceName} (${workspaceSlug})`);
    console.log(`Project: ${projectName}`);
    console.log(`User: ${userEmail}`);
    console.log(`Ticket ID: ${ticketId}`);
    console.log(`\nPlaneMonitorService should detect this ticket within 60 seconds.`);

    await client.end();
    return { workspaceId, projectId, userId, ticketId };

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    if (client) {
      await client.end().catch(() => {});
    }
    process.exit(1);
  }
}

// Run
initializePlane().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});