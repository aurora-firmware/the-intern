# Intern — system overview

## Table of Contents

- [Purpose](#purpose)
- [Design principles](#design-principles)
- [Architecture layers](#architecture-layers)
  - [Layered view](#layered-view)
  - [Component interaction view](#component-interaction-view)
  - [Interface layer](#interface-layer)
  - [Security layer](#security-layer)
    - [Identity and access](#identity-and-access)
    - [Data boundaries](#data-boundaries)
    - [Action permissions](#action-permissions)
    - [Audit trail](#audit-trail)
  - [Orchestration layer](#orchestration-layer)
    - [Message flow](#message-flow)
    - [Agent roles](#agent-roles)
    - [Action confirmation](#action-confirmation)
    - [Context and memory](#context-and-memory)
  - [Model routing](#model-routing)

-----

## Purpose

The system is a logically defined architecture for coordinating user interactions, policy enforcement, agent orchestration, memory, and model selection. It is intended to describe the structural responsibilities of the system without binding those responsibilities to a particular implementation framework.

-----

## Design principles

- **Deterministic policy first.** Authorization, routing, and action limits are enforced by explicit rules rather than by model judgment.
- **Local-first privacy.** Sensitive information should remain within controlled boundaries unless a component is explicitly permitted to process it externally.
- **Least privilege.** Each agent, channel, and tool receives only the permissions required for its role.
- **Modularity.** Interface handling, policy enforcement, orchestration, memory, and model selection remain separable.
- **Replaceability.** Concrete components may change over time without changing the underlying architectural contract.
- **Traceability.** Significant decisions and actions are recorded so the system can be inspected after the fact.

-----

## Architecture layers

### Layered view

```text
+------------------------------------------------------------+
| External channels                                           |
| User messages, notifications, queued tasks                  |
+------------------------------+-----------------------------+
                               |
                               v
+------------------------------------------------------------+
| Interface layer                                             |
| Normalizes requests and attaches sender/channel context     |
+------------------------------+-----------------------------+
                               |
                               v
+------------------------------------------------------------+
| Security layer                                              |
| Enforces identity, data boundaries, permissions, audit       |
+------------------------------+-----------------------------+
                               |
                               v
+------------------------------------------------------------+
| Orchestration layer                                         |
| Assigns roles, manages context, delegates bounded subtasks   |
+------------------------------+-----------------------------+
                               |
                               v
+------------------------------------------------------------+
| Model routing                                               |
| Selects permitted models according to role and task needs   |
+------------------------------+-----------------------------+
                               |
                               v
+------------------------------------------------------------+
| Agent execution                                             |
| Produces responses or requests authorized actions           |
+------------------------------------------------------------+
```

### Component interaction view

```text
                                 +--------------------------+
                                 |      Audit trail         |
                                 | Requests, policy, tools, |
                                 | results, failures        |
                                 +------------+-------------+
                                              ^
                                              |
+------------------+     +--------------------+--------------------+
| External channel |---->| Interface adapter                       |
| User or event    |     | Normalize request, attach channel state |
+--------+---------+     +--------------------+--------------------+
         ^                                    |
         | response                           v
         |                   +----------------+----------------+
         |                   | Policy engine                   |
         |                   | Identity, data, action checks   |
         |                   +----------------+----------------+
         |                                    |
         | authorized request                 v
+--------+---------+     +--------------------+--------------------+
| Response writer  |<----| Orchestrator                            |
| Channel output   |     | Route, assign role, manage lifecycle    |
+------------------+     +----------+----------------+-------------+
                                    |                |
                                    | context        | model request
                                    v                v
                         +----------+--------+   +---+--------------+
                         | Context manager   |   | Model router     |
                         | Working/session/  |   | Role-aware model |
                         | durable memory    |   | selection        |
                         +----------+--------+   +---+--------------+
                                    |                |
                                    | scoped context | selected model
                                    v                v
                         +----------+----------------+-------------+
                         | Primary agent                           |
                         | User interaction, task planning, reply  |
                         +----------+----------------+-------------+
                                    |
                 bounded delegation | authorized action
                         +----------+--------------------------+
                         |                                     |
                         v                                     v
              +----------+----------+              +-----------+----------+
              | Specialist agent    |              | Action executor      |
              | Narrow task scope   |              | Permitted side       |
              | and limited context |              | effects only         |
              +---------------------+              +----------------------+
```

### Interface layer

The interface layer receives inputs from one or more external channels and normalizes them into a common internal request format. A channel may be synchronous, such as interactive chat, or asynchronous, such as email or queued notifications.

Its responsibilities are:

- Accept inbound user messages and requests.
- Normalize channel-specific payloads into a shared internal representation.
- Associate each request with a sender, a channel, and a conversational or transactional context.
- Forward the normalized request to the orchestration layer.

### Security layer

The security layer defines which actors may interact with which resources and under what conditions. It is deterministic and independent of model output.

#### Identity and access

Every incoming request is evaluated against identity and access rules. The system distinguishes between:

- The user or sender initiating the request.
- The channel used to deliver the request.
- The agent or role that is allowed to receive it.

Access decisions are based on explicit policy, not on inference.

#### Data boundaries

Data is classified by sensitivity and by intended scope of use. A component may only access data that falls within its permitted boundary.

Typical boundaries include:

- User-visible conversational data.
- Task-specific working data.
- Persistent memory.
- External or delegated data sources.

The purpose of these boundaries is to prevent unnecessary exposure of sensitive information.

#### Action permissions

Outbound actions are constrained by role-specific permissions. The architecture separates:

- Read-only operations.
- State-changing operations.
- External side effects.
- Privileged operations that require stricter authorization.

An action may be blocked at the policy layer even if an agent can technically describe it.

#### Audit trail

The system records enough information to reconstruct what happened during a session or task.

The audit trail should capture:

- The incoming request.
- The routing decision.
- The action or tool invocation.
- The result or failure.
- Any policy decision that constrained the action.

The audit trail is a structural requirement, not an optional add-on.

### Orchestration layer

The orchestration layer coordinates request handling, role assignment, handoffs, and lifecycle state.

#### Message flow

A typical flow is:

1. A request enters through the interface layer.
2. The security layer validates access and scope.
3. The orchestration layer assigns the request to the appropriate agent role.
4. The agent may request additional context or delegate a bounded subtask.
5. The resulting action or response is returned through the originating channel.

This flow applies to both conversational interactions and task-oriented requests.

#### Agent roles

The architecture distinguishes between a primary agent and one or more specialist agents.

- The primary agent handles direct user interaction and maintains conversational continuity.
- Specialist agents handle narrow tasks such as research, extraction, summarization, or domain-specific reasoning.
- Delegation is bounded: the primary agent may hand off a task, but the specialist agent remains limited to its assigned scope.

#### Action confirmation

Some actions require explicit confirmation or stronger policy conditions before execution. Confirmation is used when:

- The requested action changes state externally.
- The request is incomplete or ambiguous.
- The policy demands additional verification.

The confirmation rule is part of the architecture, not a property of any specific model.

#### Context and memory

The orchestration layer manages what context is available to each agent and when.

It separates:

- Short-lived working context.
- Session context.
- Durable memory.
- Context intentionally withheld from a role.

This separation keeps agents focused and reduces accidental information leakage.

### Model routing

The model routing layer selects which model is appropriate for a given role or task. The routing decision may consider:

- Capability requirements.
- Latency.
- Privacy constraints.
- Cost.
- Task sensitivity.

The router chooses from permitted models; it does not determine policy.

The architectural contract is that model selection is replaceable and role-aware, while the rest of the system remains stable.
