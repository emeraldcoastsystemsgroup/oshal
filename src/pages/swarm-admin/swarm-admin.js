/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (B4, step B5-2): the Swarm Admin home renders the navigation the server
 *   | returns (GET /api/admin/navigation), grouped, with every value inserted as text, never as
 *   | markup. A refusal names the role; a session that has ended says to sign in again; any other
 *   | failure shows its status.
 */

const GROUP_TITLES = {
  'swarm-admin': 'Swarm Admin',
  people: 'People',
  operations: 'Operations',
};

/**
 * @description Reads the navigation as the signed-in caller.
 * @returns {Promise<{home: string, items: Array<{id: string, title: string, path: string, group: string, description: string}>}>}
 */
async function readNavigation() {
  const response = await fetch('/api/admin/navigation', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  if (response.status === 401 || response.status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
  if (!response.ok) throw new Error(`The navigation answered ${response.status}.`);
  if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('Your session has ended. Sign in again.');
  return response.json();
}

/**
 * @description Renders one group of navigation cards.
 * @param {string} group - The group key.
 * @param {Array<{title: string, path: string, description: string}>} items - Its items.
 * @returns {HTMLElement} The group section.
 */
function renderGroup(group, items) {
  const section = document.createElement('section');
  section.className = 'sa-group';
  const heading = document.createElement('h3');
  heading.textContent = GROUP_TITLES[group] ?? group;
  section.append(heading);
  const list = document.createElement('ul');
  for (const item of items) {
    const entry = document.createElement('li');
    const card = document.createElement('a');
    card.className = 'sa-card surface-card';
    card.href = item.path;
    if (item.path === window.location.pathname.replace(/\/$/, '')) card.setAttribute('aria-current', 'page');
    const title = document.createElement('strong');
    title.textContent = item.title;
    const description = document.createElement('span');
    description.textContent = item.description;
    card.append(title, description);
    entry.append(card);
    list.append(entry);
  }
  section.append(list);
  return section;
}

/**
 * @description Loads the navigation and renders it, or shows the refusal.
 * @returns {Promise<void>}
 */
async function main() {
  const status = document.getElementById('sa-status');
  const nav = document.getElementById('sa-nav');
  try {
    const navigation = await readNavigation();
    const groups = new Map();
    for (const item of navigation.items) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    nav.replaceChildren(...Array.from(groups, ([group, items]) => renderGroup(group, items)));
    status.textContent = `${navigation.items.length} pages.`;
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

void main();
