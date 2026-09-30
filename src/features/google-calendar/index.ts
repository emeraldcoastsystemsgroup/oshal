/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Feature barrel for google-calendar — a reusable Calendar v3 client wired with an injected OAuth token provider
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the CalendarBusyWindow type that freeBusy() returns
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export UpdateCalendarEventInput for meeting patch and update operations
 */

export {
  GoogleCalendarService,
  GoogleCalendarError,
} from './services/google-calendar-service';
export type {
  GoogleAccessTokenProvider,
  NormalizedCalendarEvent,
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
  CalendarBusyWindow,
} from './services/google-calendar-service';
