const fs = require('fs');
const p = '/app/dist/features/haven/haven-persona-service.js';
let c = fs.readFileSync(p, 'utf8');

// Find the exact sendRequest closing block and add model parameter
const OLD = "agentId: 'haven',\n            taskId,\n        });";
const NEW = "agentId: 'haven',\n            taskId,\n            model: process.env.HAVEN_MODEL || 'gpt-4o',\n        });";

if (c.includes(OLD)) {
  c = c.replace(OLD, NEW);
  fs.writeFileSync(p, c, 'utf8');
  console.log('PATCHED OK');
} else {
  // Try alternate spacing
  const ALT = "agentId: 'haven',\n            taskId,\n        });";
  console.log('NOT FOUND. Showing actual context:');
  const idx = c.indexOf("agentId: 'haven'");
  if (idx >= 0) {
    console.log(JSON.stringify(c.slice(idx, idx + 120)));
  } else {
    console.log('agentId line not found either');
  }
}