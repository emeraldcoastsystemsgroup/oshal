# QueueManagerService - Cline CLI Integration Patch

## Overview
This patch integrates Cline CLI support into QueueManagerService using extracted helper modules.

## Helper Modules Created
1. `PlaneDatabase.js` - Database operations
2. `TicketProcessor.js` - Ticket processing utilities
3. `CompletionEvaluator.js` - Completion evaluation
4. `ClineIntegration.js` - Cline CLI integration

## Integration Steps

### Step 1: Add imports (top of file)
```javascript
const PlaneDatabase = require('./PlaneDatabase');
const TicketProcessor = require('./TicketProcessor');
const CompletionEvaluator = require('./CompletionEvaluator');
const ClineIntegration = require('./ClineIntegration');
```

### Step 2: Initialize in constructor
```javascript
constructor(planeDbConfig, redisClient, mcpService, taskController) {
  // ... existing code ...
  
  // Add these lines:
  this.planeDb = new PlaneDatabase(this.dbConfig);
  this.clineIntegration = new ClineIntegration();
}
```

### Step 3: Add CLI check to start() method
```javascript
async start() {
  // ... existing code ...
  
  // Add before "logger.info('✓ QueueManagerService started successfully');"
  const clineStatus = await this.clineIntegration.checkAvailability();
  if (!clineStatus.available) {
    logger.warn('Cline CLI not available - falling back to AgenticController for ticket processing');
  } else {
    logger.info(`Cline CLI v${clineStatus.version} ready for ticket processing with codebase awareness`);
  }
}
```

### Step 4: Replace helper method calls

Replace these methods with helper calls:

**extractDescription:**
```javascript
// OLD:
const description = this.extractDescription(ticket);

// NEW:
const description = TicketProcessor.extractDescription(ticket);
```

**updateTicketStatus:**
```javascript
// OLD:
await this.updateTicketStatus(client, ticketId, status, projectId);

// NEW:
await this.planeDb.updateTicketStatus(client, ticketId, status, projectId);
```

**postComment:**
```javascript
// OLD:
await this.postComment(client, ticket, comment);

// NEW:
await this.planeDb.postComment(client, ticket, comment);
```

**evaluateAgentCompletion:**
```javascript
// OLD:
const evaluation = await this.evaluateAgentCompletion(agentResponse, ticket, result);

// NEW:
const evaluation = await CompletionEvaluator.evaluateAgentCompletion(agentResponse, ticket, result);
```

### Step 5: Add Cline CLI processing to processWithAgent()

Find the processWithAgent() method and add this BEFORE the AgenticController processing:

```javascript
async processWithAgent(client, ticket, agent) {
  // ... existing setup code ...
  
  // NEW: Check if Cline CLI available for codebase-aware processing
  const clineStatus = await this.clineIntegration.checkAvailability();
  
  if (clineStatus.available) {
    // Use Cline CLI (has codebase awareness!)
    logger.info(`Using Cline CLI v${clineStatus.version} for ticket ${ticket.id} (codebase-aware)`);
    try {
      const clineResult = await this.clineIntegration.processTicket(task, ticket);
      agentResponse = clineResult.result;
    } catch (cliError) {
      // Fallback to standard processing if CLI fails
      logger.warn(`Cline CLI failed, falling back to standard processing: ${cliError.message}`);
      // Continue with existing AgenticController processing...
    }
  }
  
  // ... rest of existing processWithAgent code ...
}
```

## Files to Modify
- `QueueManagerService.js` - Main service file (add imports, update method calls)

## Testing
After integration:
```bash
node any-bot/server/tests/cline-cli-queue-integration.test.js
```

## Rollback
If issues occur, simply remove the new imports and the Cline CLI check from start(). All helper methods are backwards compatible.