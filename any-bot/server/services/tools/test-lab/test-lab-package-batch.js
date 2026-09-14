/** CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run one selected package through existing disabled schedules, preserving pending recipes and uncertain outcomes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Follow the admitted batch so run history keeps refreshing between its child runs until it is terminal.
 */
let packageBatchGeneration = 0;
let packageBatchState = null;

function packageBatchControls() {
  const selected = $('historyApp').value;
  $('runPackageBatch').disabled = scheduleBusy || !selected || packageBatchState?.appName !== selected
    || !packageBatchState.canRun || !packageBatchState.ready;
  $('historyApp').disabled = scheduleBusy;
}

function exactPackageSchedule(schedule, appName) {
  return schedule && schedule.appName === appName && !schedule.unavailable && schedule.enabled === false
    && Array.isArray(schedule.levels) && [...schedule.levels].sort().join(',') === 'integration,unit';
}

async function readPackageBatch(appName) {
  const [currentCatalog, currentSchedules] = await Promise.all([fetchJson(API + '/catalog'), fetchJson(API + '/schedules')]);
  if (!Array.isArray(currentCatalog.scenarios) || !Array.isArray(currentSchedules.schedules)
    || !currentSchedules.options?.apps?.some(app => app.name === appName)) throw new Error('This package is no longer available. Refresh the catalog.');
  const tests = currentCatalog.scenarios.map(item => item.installedTest).filter(test => test?.appName === appName && test.runner.kind !== 'smoke');
  const ready = tests.filter(test => test.runnable && test.runner.kind === 'node-test' && test.runner.scope === 'package'
    && ['unit', 'integration'].includes(test.level)).length;
  const schedules = currentSchedules.schedules.filter(schedule => schedule.appName === appName);
  const compatible = schedules.length === 0 || (schedules.length === 1 && exactPackageSchedule(schedules[0], appName));
  return { appName, ready, unavailable: tests.length - ready, schedule: schedules[0], compatible,
    canRun: currentSchedules.options.canSchedule === true && compatible };
}

async function loadPackageBatch() {
  const generation = ++packageBatchGeneration, appName = $('historyApp').value;
  packageBatchState = null; packageBatchControls();
  if (!appName) { $('packageBatchCounts').textContent = 'Select one application to run its package suites.'; return; }
  $('packageBatchCounts').textContent = 'Checking current suites and access...';
  try {
    const value = await readPackageBatch(appName);
    if (generation !== packageBatchGeneration || $('historyApp').value !== appName) return;
    packageBatchState = value;
    $('packageBatchCounts').textContent = value.ready + ' ready / ' + value.unavailable + ' unavailable. Browser and framework prerequisites stay pending.'
      + (!value.compatible ? ' Existing schedule has different levels or is enabled; review Scheduled package checks. It was not changed.'
        : !value.canRun ? ' Current operator access is required.' : ' Runs once; automatic scheduling stays disabled.');
  } catch (error) {
    if (generation === packageBatchGeneration) $('packageBatchCounts').textContent = error.message;
  } finally { if (generation === packageBatchGeneration) packageBatchControls(); }
}

function requireCurrentPackage(current, appName) {
  if (!current() || $('historyApp').value !== appName) throw new Error('Package selection changed. Refresh before running.');
}

async function claimPackageBatch(appName, current) {
  const value = await readPackageBatch(appName); requireCurrentPackage(current, appName);
  if (!value.canRun || !value.ready) throw new Error(value.compatible
    ? 'No ready suites or current operator access. Refresh before running.' : 'Existing schedule is enabled or has different levels. It was not changed.');
  let schedule = value.schedule;
  if (!schedule) {
    $('packageBatchStatus').textContent = 'Creating a disabled selector for this package...';
    const created = await packageMutation('/schedules', { appName, levels: ['unit', 'integration'], cadence: 'daily' });
    requireCurrentPackage(current, appName); schedule = created.schedule;
    if (!exactPackageSchedule(schedule, appName)) throw new Error('Schedule creation result is unknown. Refresh schedules before trying again.');
  }
  $('packageBatchStatus').textContent = 'Requesting one package batch...';
  const result = await packageMutation('/schedules/' + encodeURIComponent(schedule.id) + '/run-now',
    { revision: schedule.revision, requestId: crypto.randomUUID() });
  requireCurrentPackage(current, appName);
  if (!result.batch?.id) throw new Error('Batch admission result is unknown. Check batch history before trying again.');
  return { ...result, scheduleId: schedule.id };
}

async function runSelectedPackage() {
  const appName = $('historyApp').value;
  if (scheduleBusy || !appName || $('runPackageBatch').disabled) return;
  $('schedulePanel').open = true; packageBatchGeneration++;
  $('packageBatchStatus').textContent = 'Checking the current package and disabled selector...';
  const result = await withScheduleMutation(async current => {
    try { return await claimPackageBatch(appName, current); }
    catch (error) {
      if (current()) $('packageBatchStatus').textContent = (!error.status || error.status >= 500)
        ? error.message + ' No automatic retry was made. Refresh schedules and batch history before trying again.' : error.message;
      throw error;
    }
  });
  if (result) {
    $('packageBatchStatus').textContent = 'Batch ' + result.batch.id + ' admitted. Results appear below; admission is not a passing result.';
    followBatch(result.scheduleId, result.batch);
    await scheduleHistory(result.scheduleId); await loadHistory();
  } else if (/^(Checking|Creating|Requesting)/.test($('packageBatchStatus').textContent)) {
    $('packageBatchStatus').textContent = 'The operation was interrupted. Check schedules and batch history before trying again; no automatic retry was made.';
  }
}
