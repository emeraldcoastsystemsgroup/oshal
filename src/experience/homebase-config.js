/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Display configuration for the three homebase presets (Home, Little Monsters classroom, Business). Presets choose labels, navigation, which suites and applications lead, and which modules compose the page. They carry no people, records or permissions: every person, event, list item, assignment and balance comes from the signed-in session at render time.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Classroom: names the application whose admitted tools the preset hosts in place, which tool ids stay out of the navigation (per-class tools) and which are teacher-only presentation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Every preset hosts an assembly of applications (`hosts`: app, kicker, hidden tool prefixes) and names the audience view (`view`) each hosted page is asked to render; teacher-only gating left the client (the profile arrives filtered per caller).
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Presets name the `audience` (family, classroom, company) each hosted page is asked to render; the shared kit in /shared/ui reads the same word
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Wider assemblies (ADR-164: an experience is an assembly of shared applications rewritten for its audience). The classroom also hosts AI Office ("Make and share") and Circuit Lab ("Build and test"); Home adds Movies & TV, Music and Travel as "Watch", "Listen" and "Go"; Business adds Intelligent Communication and World Intelligence under Office, Social beside Switchboard under Communications, and Marketing Engine and Venture Plan under Growth. Existing hosts and hidden prefixes are unchanged. Where a new host's ribbon lists several surfaces, the ones that are not the page carrying the audience view are hidden (Intelligent Communication keeps My Day, Social keeps the Composer, Marketing Engine keeps its campaign page).
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Composed front pages (`modules`): each preset declares its front page as two ordered columns of core modules, role pairs ({teacher, otherwise}) and package summary cards ({card, title, kicker, action}) that homebase.js renders from the application's own ADR-145 home-summary probe. Business leads with today's email digest, the office calendar, recent documents and the Federal CRM pipeline, with payroll, calls and lists beside; Home leads with the shared calendar and the person's money or school by role; the classroom is unchanged. Business also hosts Calendar, Federal CRM (six of its twenty surfaces in the rails) and Calling Assistant; Home hosts AI Office for its documents card. The shopping module's heading is per preset (`shoppingHeading`).
 * 7 | maintainer@emeraldcoastsystemsgroup.com | The design study's Home check-ins and household: the front page opens with the room strip (the home assistant and the household), gains the opt-in check-ins after the personal module and the Family admin card in the aside. Business and the classroom are unchanged.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Home's navigation gains Routines, and Room / Tasks / Files tabs sit above the page (`tabs`).
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Replace promotional runtime headings with schedules, classwork, applications and household/team updates; preserve gallery assets and member permissions.
 */
window.HOMEBASE_PRESETS = {
  family: {
    id: 'family', skin: 'family', name: 'Home', short: 'homebase', mark: 'h',
    eyebrow: 'HOME', title: 'Today',
    subtitle: 'Schedule, lists and household updates.',
    nav: [['home', 'Our home'], ['calendar', 'Calendar'], ['shopping', 'Shopping list'], ['people', 'Our people'], ['personal', 'Just for me'], ['routines', 'Routines']],
    // Room sections above the page: the room itself, the open things to take care of, and the files from the assistant.
    tabs: [['home', 'Room'], ['tasks', 'Tasks'], ['files', 'Files']],
    suites: ['ai-home', 'ai-creative', 'ai-knowledge', 'ai-finance'], featured: ['home', 'little-monsters', 'purchasing', 'games'],
    peopleKicker: 'HOUSEHOLD', appsHeading: 'Applications', updatesHeading: 'Household updates',
    calendarHeading: "Today's Schedule", assistantPrompt: 'Ask about your schedule, lists or household.', assistantLabel: 'Your home assistant',
    sidebarNote: ['Access and sharing', 'Your calendar and list are shared where an application shares them. Your money and schoolwork stay in their own spaces.'],
    // The applications this home hosts in place, in this order; hidden prefixes keep off-audience tiles out of the rails.
    hosts: [
      { app: 'home', kicker: 'SMART HOME', hiddenTools: ['tool-home-drone', 'tool-home-sat-ops', 'tool-home-pumpkin', 'tool-home-spaces', 'tool-home-camera', 'tool-home-accounts'] },
      { app: 'purchasing', kicker: 'SHOPPING' },
      { app: 'finance', kicker: 'MONEY', hiddenTools: ['tool-finance-trading', 'tool-finance-world', 'tool-finance-kalshi'] },
      { app: 'little-monsters', kicker: 'LITTLE MONSTERS', hiddenTools: ['tool-lm-class-'] },
      // Watch, listen, go: one surface each, the page that carries the family view.
      { app: 'movies', kicker: 'WATCH' },
      { app: 'spotify', kicker: 'LISTEN' },
      { app: 'travel', kicker: 'GO' },
      // The documents card's application; office matters less at home, so it comes last.
      { app: 'presentations', kicker: 'OFFICE' }
    ],
    audience: 'family',
    shoppingHeading: 'Shopping List',
    // The front page, main column then aside: the shared calendar first, then money (a parent) or school (a learner)
    // through the role-led personal module, the house, the tools; the list, recent documents and the noticeboard beside.
    modules: {
      main: ['room', 'calendar', 'personal', 'locations', 'home-facts', 'apps'],
      aside: ['shopping', { card: 'presentations', title: 'Recent documents', kicker: 'OFFICE', action: { label: 'Open AI Office', tool: 'tool-presentations-studio' } }, 'family-admin', 'updates']
    }
  },
  classroom: {
    id: 'classroom', skin: 'classroom', name: 'Little Monsters', short: 'little monsters', mark: 'm',
    eyebrow: 'CLASSROOM', title: 'Classwork',
    subtitle: 'Assignments, class schedule and learning progress.',
    nav: [['home', 'Our classroom'], ['requirements', 'Classwork'], ['calendar', 'Class calendar'], ['personal', 'My learning'], ['people', 'Class community']],
    suites: ['ai-home', 'ai-knowledge', 'ai-creative'], featured: ['little-monsters', 'games'],
    peopleKicker: 'CLASS COMMUNITY', appsHeading: 'Applications', updatesHeading: 'Class updates',
    calendarHeading: "Today's Schedule", assistantPrompt: 'Ask about your classwork or study materials.', assistantLabel: 'Study assistant',
    sidebarNote: ['Access and sharing', 'Classwork is shared with your class. Your personal learning stays in your space.'],
    hosts: [
      { app: 'little-monsters', kicker: 'LITTLE MONSTERS', hiddenTools: ['tool-lm-class-'] },
      { app: 'presentations', kicker: 'MAKE AND SHARE' },
      { app: 'circuit-lab', kicker: 'BUILD AND TEST' }
    ],
    audience: 'classroom',
    // Unchanged composition, declared the same way: a teacher sees the roster where a learner sees the class calendar.
    modules: {
      main: ['requirements', { teacher: 'roster', otherwise: 'calendar' }, 'apps'],
      aside: [{ teacher: 'calendar', otherwise: 'personal' }, 'updates']
    }
  },
  company: {
    id: 'company', skin: 'company', name: 'Business', short: 'workspace', mark: 'w',
    eyebrow: 'BUSINESS', title: 'Today',
    subtitle: 'Schedule, projects and recent work.',
    nav: [['home', 'Overview'], ['projects', 'Projects'], ['calendar', 'Team calendar'], ['people', 'People & specialists'], ['personal', 'My workspace']],
    suites: ['ai-productivity', 'ai-engineering', 'ai-finance', 'ai-knowledge'], featured: ['presentations', 'cad-studio', 'marketing-suite', 'finance'],
    peopleKicker: 'TEAM', appsHeading: 'Applications', updatesHeading: 'Team updates',
    calendarHeading: 'Team Schedule', assistantPrompt: 'Ask about your schedule, projects or documents.', assistantLabel: 'Work assistant',
    sidebarNote: ['Access and sharing', 'Team work stays shared. Personal conversations and restricted applications stay scoped to you.'],
    // Office, Communications and Growth sit beside the hosts they belong with; each new host shows only the page that
    // carries the company view (its other ribbon surfaces stay in the full application).
    hosts: [
      { app: 'presentations', kicker: 'PRESENTATIONS' },
      { app: 'email-summarizer', kicker: 'OFFICE · EMAIL', hiddenTools: ['tool-email-inbox', 'tool-email-social'] },
      { app: 'calendar', kicker: 'OFFICE · CALENDAR' },
      { app: 'world', kicker: 'OFFICE · WORLD BRIEFING' },
      { app: 'finance', kicker: 'FINANCE', hiddenTools: ['tool-finance-trading', 'tool-finance-world', 'tool-finance-kalshi'] },
      { app: 'switchboard', kicker: 'COMMUNICATIONS' },
      { app: 'social', kicker: 'COMMUNICATIONS · SOCIAL', hiddenTools: ['tool-social-workspace', 'tool-linkedin-assistant', 'tool-social-signals', 'tool-social-accounts'] },
      { app: 'calling-assistant', kicker: 'COMMUNICATIONS · CALLS' },
      { app: 'marketing-engine', kicker: 'GROWTH · MARKETING', hiddenTools: ['tool-marketing-content-studio', 'tool-marketing-linkedin-assistant'] },
      { app: 'venture-plan', kicker: 'GROWTH · VENTURES' },
      // Federal CRM: the pipeline surfaces stay in the rails; record lists, imports, reports and administration stay in the full application.
      { app: 'capture-crm', kicker: 'CRM · FEDERAL', hiddenTools: ['tool-federal-contacts', 'tool-federal-accounts', 'tool-federal-activities', 'tool-federal-calendar', 'tool-federal-library', 'tool-federal-reports', 'tool-federal-targets', 'tool-federal-import', 'tool-federal-proposals', 'tool-federal-comms', 'tool-federal-assistant', 'tool-federal-underwriting', 'tool-federal-admin', 'tool-federal-help'] },
      { app: 'payroll', kicker: 'PAYROLL' },
      { app: 'payments', kicker: 'PAYMENTS' },
      { app: 'identity', kicker: 'IDENTITY' },
      { app: 'cad-studio', kicker: 'ENGINEERING' }
    ],
    audience: 'company',
    shoppingHeading: 'Your lists',
    // The front desk: today's email digest, the office calendar, recent documents and the Federal CRM pipeline lead,
    // then the shared work and the tools; payroll, calls, lists, the personal card and the team feed beside. Each card
    // is the application's own summary; the Team calendar page keeps the Little Monsters calendar module.
    modules: {
      main: [
        { card: 'email-summarizer', title: 'Today', kicker: 'OFFICE · EMAIL', action: { label: 'Open My Day', tool: 'tool-email-myday' } },
        { card: 'calendar', title: 'Office calendar', kicker: 'OFFICE · CALENDAR', action: { label: 'Open Calendar', tool: 'tool-calendar-review' } },
        { card: 'presentations', title: 'Recent documents', kicker: 'OFFICE · DOCUMENTS', action: { label: 'Open AI Office', tool: 'tool-presentations-studio' } },
        { card: 'capture-crm', title: 'Capture pipeline', kicker: 'CRM · FEDERAL', action: { label: 'Open Federal CRM', tool: 'tool-federal-home' } },
        'projects', 'apps'
      ],
      aside: [
        { card: 'payroll', title: 'Payroll', kicker: 'PAYROLL', action: { label: 'Open Payroll', tool: 'tool-payroll-home' } },
        { card: 'calling-assistant', title: 'Calls', kicker: 'COMMUNICATIONS · CALLS', action: { label: 'Open Calling', tool: 'tool-calling-settings' } },
        'shopping', 'personal', 'updates'
      ]
    }
  }
};
