/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial demo-mode types — seed profile, seeded entity ids
 */

/** Summary of what the demo seeder wrote (or found already present) on this boot. */
export interface DemoSeedSummary {
  executed: boolean;
  reason?: string;
  studentId?: string;
  teacherName?: string;
  classIds?: string[];
  flashcardSetIds?: string[];
  assignmentIds?: string[];
  enrollmentCount?: number;
}

/** The mock user injected by createMockOidcMiddleware and returned by /api/auth/user. */
export interface DemoUser {
  sub: string;
  name: string;
  email: string;
  preferredUsername: string;
  roles: string[];
}
