/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Validate explicit in-process package tools through one CLI/runtime contract.
 */
'use strict';
/** @description Validate fixed package executors without granting any runtime authority.
 * @param manifest Parsed application manifest. @returns Declared tool names and enabled posture.
 */
function validatePackageTools(manifest) {
  const declarations = [];
  for (const tool of Array.isArray(manifest.tools) ? manifest.tools : []) {
    if (tool?.executor?.builtinKey !== 'package') continue;
    if (!Array.isArray(manifest.uses) || !manifest.uses.includes('package-tools') || !manifest.uses.includes('application-authorization')
      || manifest.authorization?.version !== 1) throw new Error('Package tools require package-tools and application-authorization capabilities and a catalog');
    if (tool.executor.executorType !== 'builtin' || Object.keys(tool.executor).some(key => !['executorType', 'builtinKey'].includes(key))) {
      throw new Error('Package tool executor must be exactly builtin/package without another transport');
    }
    if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(tool.name)
      || ['constructor', 'prototype', '__proto__'].includes(tool.name) || tool.name.startsWith('swarm_')) throw new Error('Invalid or reserved package tool name');
    if (!['auto', 'ask', 'off'].includes(tool.defaultAuthMode)) throw new Error('Package tool must declare its defaultAuthMode');
    if (declarations.some(item => item.name === tool.name)) throw new Error('Duplicate package tool declaration');
    declarations.push({ name: tool.name, enabled: tool.enabled !== false && tool.defaultAuthMode !== 'off' });
  }
  return declarations;
}
module.exports = { validatePackageTools };
