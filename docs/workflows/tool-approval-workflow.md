<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial approval workflow documentation
-->

# Tool Approval Workflow

## Overview

The tool approval workflow governs how AI agents request permission to use tools during chat sessions. When a tool's `auth_mode` is set to `ASK`, the user must explicitly approve or deny each tool invocation in real-time via the Chat UI.

## End-to-End Flow

```mermaid
sequenceDiagram
    actor User
    participant Chat as Chat UI
    participant Agent as AI Agent
    participant SW as Switch Framework
    participant SSE as SSE Manager
    participant Tool as External Tool

    User->>Chat: "What's the weather in Chicago?"
    Chat->>Agent: Process user message
    Agent->>Agent: Decides to use weather_api tool
    Agent->>SW: requestToolExecution("weather_api", {city: "Chicago"})
    
    SW->>SW: Check auth_mode for weather_api
    
    alt auth_mode = AUTO
        SW->>Tool: Execute immediately
        Tool-->>SW: Result
        SW-->>Agent: Tool result
    else auth_mode = ASK
        SW->>SSE: Send approval request
        SSE->>Chat: SSE event: tool_approval_request
        Chat->>User: 🔔 Approval Dialog appears
        
        Note over User,Chat: "weather_api wants to run<br/>Parameters: {city: Chicago}<br/>[Approve] [Deny]"
        
        alt User clicks Approve
            User->>Chat: Click Approve
            Chat->>SW: POST /api/tools/approve/:requestId
            SW->>Tool: Execute tool
            Tool-->>SW: Weather data
            SW-->>Agent: Tool result
            Agent-->>Chat: "The weather in Chicago is 45°F..."
            Chat-->>User: Display response
        else User clicks Deny
            User->>Chat: Click Deny
            Chat->>SW: POST /api/tools/deny/:requestId
            SW-->>Agent: {status: "denied"}
            Agent-->>Chat: "I wasn't able to check the weather..."
            Chat-->>User: Display fallback response
        else 30 second timeout
            SW->>SW: Timeout expires
            SW-->>Agent: {status: "timeout"}
            Agent-->>Chat: "The tool request timed out..."
            Chat-->>User: Display timeout response
        end
    else auth_mode = OFF
        SW-->>Agent: {status: "disabled"}
        Agent->>Agent: Proceed without tool
    end
```

## Approval Dialog UI

The approval dialog appears as an overlay in the Chat UI with:

1. **Tool name** and icon
2. **Description** of what the tool does
3. **Parameters** the agent wants to pass (sanitized)
4. **Approve** button (green) — executes the tool
5. **Deny** button (red) — blocks execution
6. **Timer** — 30-second countdown before auto-timeout

## Auth Mode Configuration

Admins configure auth modes on the **Agent Config** page (`agent-tools.html`):

| Mode | Behavior | Use Case |
|------|----------|----------|
| `AUTO` | Execute without asking | Trusted, low-risk tools (calculator, search) |
| `ASK` | Require user approval | Sensitive tools (email, file write, API calls) |
| `OFF` | Block entirely | Disabled or deprecated tools |

## Approval Request Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING: Agent requests tool
    PENDING --> APPROVED: User approves
    PENDING --> DENIED: User denies
    PENDING --> TIMEOUT: 30s elapsed
    APPROVED --> [*]: Tool executed
    DENIED --> [*]: Agent notified
    TIMEOUT --> [*]: Agent notified
```

All approval requests are stored in `tool_approval_requests` for audit purposes.