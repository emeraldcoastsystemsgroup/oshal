/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: fixture presets (family, classroom, company) for the configurable homebase prototype; people, records and permissions are demonstration data. The example household was renamed to the fictional Brooks home when packaged; the people in these presets are fictional.
 */
// Proposed experience presets. All people, records and permissions below are demonstration fixtures.
window.HOMEBASE_PRESETS = {
 family: {
  name: 'The Brooks home', short: 'homebase', mark: 'h', theme: 'cozy', eyebrow: 'OUR LITTLE CORNER OF THE WORLD',
  title: 'Everyone has a place here.', subtitle: 'The shared parts of life, together. A little space for yourself, too.',
  nav: [['home','Our home'],['calendar','Family calendar'],['shopping','Shopping list'],['people','Our people'],['personal','Just for me']],
  users: [
   {id:'alex',name:'Alex',role:'Parent · swarm admin',initials:'A',caps:['configure','finance','install'],color:'green',location:'At the office',stamp:'Updated 8 min ago'},
   {id:'jamie',name:'Jamie',role:'Parent',initials:'J',caps:['finance'],color:'rose',location:'At home',stamp:'Updated 4 min ago'},
   {id:'mia',name:'Mia',role:'Child · grade 6',initials:'M',caps:['learn'],color:'gold',location:'At school',stamp:'Updated 12 min ago'},
   {id:'leo',name:'Leo',role:'Child · grade 3',initials:'L',caps:['learn'],color:'blue',location:'At school',stamp:'Updated 15 min ago'}
  ],
  calendar:[{time:'3:15',period:'PM',title:'School pickup',detail:'Jamie + Mia + Leo',tag:'Together'},{time:'4:30',period:'PM',title:'Soccer practice',detail:'Leo · Riverside field',tag:'Family'},{time:'6:30',period:'PM',title:'Make-your-own pizza',detail:'Everyone · at home',tag:'Together'}],
  apps:[['home','Smart Home','Lights, rooms & routines'],['little-monsters','Little Monsters','School, at your pace'],['purchasing','Shopping','One list, everyone helps'],['games','Games','Something fun together']],
  updates:[['Jamie','Added mozzarella to the shopping list.','10 min ago'],['Mia','Shared the science fair date.','28 min ago'],['Home assistant','Your evening routine is ready to review.','45 min ago']]
 },
 classroom: {
  name:'Little Monsters',short:'little monsters',mark:'m',theme:'playful',eyebrow:'OAK ROOM / GRADE 6 SCIENCE',
  title:'Big ideas. Little monsters.',subtitle:'A place to wonder, make a mess, and figure things out together.',
  nav:[['home','Our classroom'],['requirements','This week’s quest'],['calendar','Class calendar'],['personal','My learning'],['people','Class community']],
  users:[
   {id:'rivera',name:'Ms. Rivera',role:'Teacher · Oak room',initials:'SR',caps:['teach','configure'],color:'rose'},
   {id:'mia',name:'Mia',role:'Student · Oak room',initials:'M',caps:['learn'],color:'gold'},
   {id:'leo',name:'Leo',role:'Student · Oak room',initials:'L',caps:['learn'],color:'blue'},
   {id:'ava',name:'Ava',role:'Student · Oak room',initials:'AV',caps:['learn'],color:'green'}
  ],
  calendar:[{time:'9:00',period:'AM',title:'How does a seed wake up?',detail:'Oak room · science circle',tag:'Class'},{time:'10:30',period:'AM',title:'Build your mini greenhouse',detail:'Pairs · materials table',tag:'Workshop'},{time:'2:00',period:'PM',title:'Share one discovery',detail:'Oak room · reflection',tag:'Class'}],
  apps:[['little-monsters','My learning','Notes, quizzes & your tutor'],['materials','Class library','Teacher-approved resources'],['flashcards','Flashcards','A small step at a time'],['games','Learning break','Make room for play']],
  updates:[['Ms. Rivera','The seed journal guide is ready for everyone.','15 min ago'],['Class notice','Bring a clean jar on Monday. We have spares.','1 hour ago'],['Study companion','A quiet focus session is ready when you are.','Today']]
 },
 company: {
  name:'Northstar Works',short:'northstar',mark:'n',theme:'professional',eyebrow:'ONE TEAM. ONE SHARED DIRECTION.',
  title:'Good work starts here.',subtitle:'Your people, your applications and the work between them. In one place.',
  nav:[['home','Overview'],['projects','Team projects'],['calendar','Team calendar'],['people','People & specialists'],['personal','My workspace']],
  users:[
   {id:'morgan',name:'Morgan',role:'Operations · swarm admin',initials:'MO',caps:['configure','finance','install','lead'],color:'green'},
   {id:'sam',name:'Sam',role:'Engineering lead',initials:'SA',caps:['lead'],color:'blue'},
   {id:'jules',name:'Jules',role:'Design',initials:'JU',caps:['member'],color:'rose'},
   {id:'robin',name:'Robin',role:'Marketing',initials:'RO',caps:['member'],color:'gold'}
  ],
  calendar:[{time:'9:30',period:'AM',title:'Product team stand-up',detail:'Engineering + design · 15 min',tag:'Team'},{time:'11:00',period:'AM',title:'Enclosure design review',detail:'Sam + Jules · project room',tag:'Review'},{time:'2:00',period:'PM',title:'Launch readiness',detail:'Cross-team · 30 min',tag:'Team'}],
  apps:[['cad-studio','CAD Studio','Design & engineering'],['presentations','AI Office','Documents & reviews'],['marketing','Marketing','Campaigns & launch work'],['finance','Finance','Granted users only']],
  updates:[['CAD specialist','Enclosure revision 4 is ready for team review.','6 min ago'],['Sam','Moved power-stage validation into review.','18 min ago'],['Robin','Shared the launch brief with the product team.','34 min ago']]
 }
};
