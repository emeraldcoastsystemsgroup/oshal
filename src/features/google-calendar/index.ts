/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Feature barrel for google-calendar — a reusable Calendar v3 client wired with an injected OAuth token provider
 */

export {
  GoogleCalendarService,
  GoogleCalendarError,
} from './services/google-calendar-service';
export type {
  GoogleAccessTokenProvider,
  NormalizedCalendarEvent,
  CreateCalendarEventInput,
} from './services/google-calendar-service';
