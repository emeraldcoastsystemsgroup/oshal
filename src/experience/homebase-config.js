/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Every preset hosts an assembly of applications (`hosts`: app, kicker, hidden tool prefixes) and names the audience view (`view`) each hosted page is asked to render; teacher-only gating left the client (the profile arrives filtered per caller).
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Classroom: names the application whose admitted tools the preset hosts in place, which tool ids stay out of the navigation (per-class tools) and which are teacher-only presentation.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Display configuration for the three homebase presets (Home, Little Monsters classroom, Business). Presets choose labels, navigation, which suites and applications lead, and which modules compose the page. They carry no people, records or permissions: every person, event, list item, assignment and balance comes from the signed-in session at render time.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Presets name the `audience` (family, classroom, company) each hosted page is asked to render; the shared kit in /shared/ui reads the same word
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Wider assemblies (ADR-164: an experience is an assembly of shared applications rewritten for its audience). The classroom also hosts AI Office ("Make and share") and Circuit Lab ("Build and test"); Home adds Movies & TV, Music and Travel as "Watch", "Listen" and "Go"; Business adds Intelligent Communication and World Intelligence under Office, Social beside Switchboard under Communications, and Marketing Engine and Venture Plan under Growth. Existing hosts and hidden prefixes are unchanged. Where a new host's ribbon lists several surfaces, the ones that are not the page carrying the audience view are hidden (Intelligent Communication keeps My Day, Social keeps the Composer, Marketing Engine keeps its campaign page).
 */
window.HOMEBASE_PRESETS = {
  family: {
    id: 'family', skin: 'family', name: 'Home', short: 'homebase', mark: 'h',
    eyebrow: 'OUR LITTLE CORNER OF THE WORLD', title: 'Everyone has a place here.',
    subtitle: 'The shared parts of life, together. A little space for yourself, too.',
    nav: [['home', 'Our home'], ['calendar', 'Calendar'], ['shopping', 'Shopping list'], ['people', 'Our people'], ['personal', 'Just for me']],
    suites: ['ai-home', 'ai-creative', 'ai-knowledge', 'ai-finance'], featured: ['home', 'little-monsters', 'purchasing', 'games'],
    peopleKicker: 'AT HOME WITH YOU', appsHeading: 'A few things that make life easier.', updatesHeading: 'Around the house',
    calendarHeading: 'Today, together.', assistantPrompt: 'What would make today a little easier?', assistantLabel: 'Your home assistant',
    sidebarNote: ['Shared life. Personal space.', 'Your calendar and list are shared where an application shares them. Your money and schoolwork stay in their own spaces.'],
    // The applications this home hosts in place, in this order; hidden prefixes keep off-audience tiles out of the rails.
    hosts: [
      { app: 'home', kicker: 'SMART HOME', hiddenTools: ['tool-home-drone', 'tool-home-sat-ops', 'tool-home-pumpkin', 'tool-home-spaces', 'tool-home-camera', 'tool-home-accounts'] },
      { app: 'purchasing', kicker: 'SHOPPING' },
      { app: 'finance', kicker: 'MONEY', hiddenTools: ['tool-finance-trading', 'tool-finance-world', 'tool-finance-kalshi'] },
      { app: 'little-monsters', kicker: 'LITTLE MONSTERS', hiddenTools: ['tool-lm-class-'] },
      // Watch, listen, go: one surface each, the page that carries the family view.
      { app: 'movies', kicker: 'WATCH' },
      { app: 'spotify', kicker: 'LISTEN' },
      { app: 'travel', kicker: 'GO' }
    ],
    audience: 'family'
  },
  classroom: {
    id: 'classroom', skin: 'classroom', name: 'Little Monsters', short: 'little monsters', mark: 'm',
    eyebrow: 'OUR CLASSROOM', title: 'Big ideas. Little monsters.',
    subtitle: 'A place to wonder, make a mess, and figure things out together.',
    nav: [['home', 'Our classroom'], ['requirements', 'Classwork'], ['calendar', 'Class calendar'], ['personal', 'My learning'], ['people', 'Class community']],
    suites: ['ai-home', 'ai-knowledge', 'ai-creative'], featured: ['little-monsters', 'games'],
    peopleKicker: 'LEARNING TOGETHER', appsHeading: 'Tools for curious minds.', updatesHeading: 'On our noticeboard',
    calendarHeading: 'Our day of discovery.', assistantPrompt: 'One question is a great start.', assistantLabel: 'Your study companion',
    sidebarNote: ['A little room to grow.', 'Classwork is shared with your class. Your personal learning stays in your space.'],
    hosts: [
      { app: 'little-monsters', kicker: 'LITTLE MONSTERS', hiddenTools: ['tool-lm-class-'] },
      { app: 'presentations', kicker: 'MAKE AND SHARE' },
      { app: 'circuit-lab', kicker: 'BUILD AND TEST' }
    ],
    audience: 'classroom'
  },
  company: {
    id: 'company', skin: 'company', name: 'Business', short: 'workspace', mark: 'w',
    eyebrow: 'ONE TEAM. ONE SHARED DIRECTION.', title: 'Good work starts here.',
    subtitle: 'Your people, your applications and the work between them. In one place.',
    nav: [['home', 'Overview'], ['projects', 'Projects'], ['calendar', 'Team calendar'], ['people', 'People & specialists'], ['personal', 'My workspace']],
    suites: ['ai-productivity', 'ai-engineering', 'ai-finance', 'ai-knowledge'], featured: ['presentations', 'cad-studio', 'marketing-suite', 'finance'],
    peopleKicker: 'YOUR PEOPLE', appsHeading: 'Your team’s working toolkit.', updatesHeading: 'Across the team',
    calendarHeading: 'On the team calendar', assistantPrompt: 'What would make today a little easier?', assistantLabel: 'Your work assistant',
    sidebarNote: ['Together, with boundaries.', 'Team work stays shared. Personal conversations and restricted applications stay scoped to you.'],
    // Office, Communications and Growth sit beside the hosts they belong with; each new host shows only the page that
    // carries the company view (its other ribbon surfaces stay in the full application).
    hosts: [
      { app: 'presentations', kicker: 'PRESENTATIONS' },
      { app: 'email-summarizer', kicker: 'OFFICE · EMAIL', hiddenTools: ['tool-email-inbox', 'tool-email-social'] },
      { app: 'world', kicker: 'OFFICE · WORLD BRIEFING' },
      { app: 'finance', kicker: 'FINANCE', hiddenTools: ['tool-finance-trading', 'tool-finance-world', 'tool-finance-kalshi'] },
      { app: 'switchboard', kicker: 'COMMUNICATIONS' },
      { app: 'social', kicker: 'COMMUNICATIONS · SOCIAL', hiddenTools: ['tool-social-workspace', 'tool-linkedin-assistant', 'tool-social-signals', 'tool-social-accounts'] },
      { app: 'marketing-engine', kicker: 'GROWTH · MARKETING', hiddenTools: ['tool-marketing-content-studio', 'tool-marketing-linkedin-assistant'] },
      { app: 'venture-plan', kicker: 'GROWTH · VENTURES' },
      { app: 'payroll', kicker: 'PAYROLL' },
      { app: 'payments', kicker: 'PAYMENTS' },
      { app: 'identity', kicker: 'IDENTITY' },
      { app: 'cad-studio', kicker: 'ENGINEERING' }
    ],
    audience: 'company'
  }
};
