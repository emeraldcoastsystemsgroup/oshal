/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Display configuration for the three homebase presets (Home, Little Monsters classroom, Business). Presets choose labels, navigation, which suites and applications lead, and which modules compose the page. They carry no people, records or permissions: every person, event, list item, assignment and balance comes from the signed-in session at render time.
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
    sidebarNote: ['Shared life. Personal space.', 'Your calendar and list are shared where an application shares them. Your money and schoolwork stay in their own spaces.']
  },
  classroom: {
    id: 'classroom', skin: 'classroom', name: 'Little Monsters', short: 'little monsters', mark: 'm',
    eyebrow: 'OUR CLASSROOM', title: 'Big ideas. Little monsters.',
    subtitle: 'A place to wonder, make a mess, and figure things out together.',
    nav: [['home', 'Our classroom'], ['requirements', 'Classwork'], ['calendar', 'Class calendar'], ['personal', 'My learning'], ['people', 'Class community']],
    suites: ['ai-home', 'ai-knowledge', 'ai-creative'], featured: ['little-monsters', 'games'],
    peopleKicker: 'LEARNING TOGETHER', appsHeading: 'Tools for curious minds.', updatesHeading: 'On our noticeboard',
    calendarHeading: 'Our day of discovery.', assistantPrompt: 'One question is a great start.', assistantLabel: 'Your study companion',
    sidebarNote: ['A little room to grow.', 'Classwork is shared with your class. Your personal learning stays in your space.']
  },
  company: {
    id: 'company', skin: 'company', name: 'Business', short: 'workspace', mark: 'w',
    eyebrow: 'ONE TEAM. ONE SHARED DIRECTION.', title: 'Good work starts here.',
    subtitle: 'Your people, your applications and the work between them. In one place.',
    nav: [['home', 'Overview'], ['projects', 'Projects'], ['calendar', 'Team calendar'], ['people', 'People & specialists'], ['personal', 'My workspace']],
    suites: ['ai-productivity', 'ai-engineering', 'ai-finance', 'ai-knowledge'], featured: ['presentations', 'cad-studio', 'marketing-suite', 'finance'],
    peopleKicker: 'YOUR PEOPLE', appsHeading: 'Your team’s working toolkit.', updatesHeading: 'Across the team',
    calendarHeading: 'On the team calendar', assistantPrompt: 'What would make today a little easier?', assistantLabel: 'Your work assistant',
    sidebarNote: ['Together, with boundaries.', 'Team work stays shared. Personal conversations and restricted applications stay scoped to you.']
  }
};
