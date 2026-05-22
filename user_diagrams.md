# Service Code Component Diagram

```mermaid
flowchart TB
    subgraph ClientSide["External / Local Callers"]
        CLI["bob CLI subcommands"]
        AdminClient["Admin JSON-RPC client"]
        FutureChannels["Future channel adapters\nchat / email / webhook / scheduler"]
        PiAgent["pi-agent child processes"]
        JsExt["JS extension inside pi-agent"]
    end

    subgraph Bob["bob serve runtime"]
        Config["BobConfig\nsocket paths, pool sizes, policy, audit log"]

        subgraph AdminRpc["crates/admin-rpc"]
            AdminSock["admin.sock\nUnix socket + peer UID gate"]
            AdminProtocol["JSON-RPC 2.0 framing"]
            Dispatcher["Dispatcher\nmethod routing"]
        end

        subgraph ExtensionIpc["crates/extension-ipc"]
            ExtSock["extension.sock\nUnix socket + peer UID gate"]
            ExtFrames["newline JSON frames\nkind=authz | event"]
            Multiplexer["SessionMultiplexer\npolicy verdict routing + event audit"]
        end

        subgraph RequestPath["crates/requests-handler"]
            ReqQueue["bounded request queue"]
            Preflight["run_preflight\nidentity/policy admission"]
        end

        subgraph Core["crates/bob-core"]
            Types["types\nInternalEvent, RequestContext,\nSessionId, UserId, AuditRecord"]
            Ports["ports traits\nRequestsHandler, PersistenceStore,\nAuditSink"]
        end

        subgraph Policy["crates/policy-control"]
            Snapshot["policy snapshot"]
            PolicyEngine["PolicyEngine\nadmission + action rules"]
        end

        subgraph Persistence["crates/persistence"]
            InboundStore["in-memory inbound queue"]
            SessionState["session state store"]
        end

        subgraph Monitoring["crates/monitoring"]
            AuditLog["append-only audit log"]
            TailSubs["audit tail subscribers"]
        end

        subgraph Supervisor["crates/pi-agent-supervisor"]
            Pool["SessionPool\nwarm + active workers"]
            WorkerProc["RpcWorkerProcess\nspawn pi, stdin/stdout JSON"]
        end
    end

    CLI --> AdminClient --> AdminSock
    AdminSock --> AdminProtocol --> Dispatcher

    Dispatcher -->|"service.status"| Dispatcher
    Dispatcher -->|"sessions.list / kill"| Pool
    Dispatcher -->|"policy.reload"| Snapshot
    Dispatcher -->|"audit.tail.subscribe"| TailSubs
    Dispatcher -->|"report.submit"| AuditLog
    Dispatcher -. "chat.send not implemented" .-> ReqQueue

    Config --> AdminSock
    Config --> ExtSock
    Config --> Pool
    Config --> Snapshot
    Config --> AuditLog

    FutureChannels -. "not implemented yet" .-> ReqQueue
    ReqQueue --> Preflight
    Preflight -->|"allowed"| InboundStore
    Preflight -->|"allow/deny audit"| AuditLog
    Preflight --> PolicyEngine
    PolicyEngine --> Snapshot

    Pool --> WorkerProc
    WorkerProc -->|"spawns"| PiAgent
    WorkerProc -->|"BOB_SESSION_ID\nBOB_EXTENSION_SOCK_PATH"| PiAgent
    WorkerProc -->|"prompt JSON over stdin/stdout"| PiAgent

    PiAgent --> JsExt
    JsExt -. "connects to extension.sock" .-> ExtSock
    ExtSock --> ExtFrames --> Multiplexer
    Multiplexer -->|"authz frame"| PolicyEngine
    Multiplexer -->|"authz_verdict"| JsExt
    Multiplexer -->|"event frame"| AuditLog

    Types --- ReqQueue
    Types --- Persistence
    Types --- Monitoring
    Types --- Supervisor
    Ports --- ReqQueue
    Ports --- Persistence
    Ports --- Monitoring
```

## Current Implementation Notes

- `admin.sock` currently serves admin/reporting JSON-RPC methods such as `service.status`, `sessions.list`, `sessions.kill`, `policy.reload`, audit tail subscription, and `report.submit`.
- `chat.send` is present as a method name but is not implemented.
- `extension.sock` is intended for pi-agent extension traffic: authorization requests and extension events tagged by session.
- `requests-handler` can queue and preflight internal events, then enqueue allowed events into persistence.
- There is not yet a public channel-agnostic `request.submit` socket method that accepts normalized input, starts or selects a pi-agent session, sends a prompt, and optionally returns the agent response.

# Target Input Flow Sequence Diagrams

These sequence diagrams describe the intended next-phase behavior. The generic
`request.submit` facade, channel-agnostic input envelope, request-to-pi-agent
dispatch, and synchronous response routing are not implemented yet.

## CLI Chat With Response

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as bob CLI
    participant AdminSock as admin.sock / request.submit
    participant Dispatcher as Admin RPC Dispatcher
    participant Requests as requests-handler
    participant Policy as policy-control
    participant Supervisor as pi-agent-supervisor
    participant Pi as pi-agent session
    participant Ext as JS extension
    participant Monitoring as monitoring

    User->>CLI: bob chat "message"
    CLI->>AdminSock: JSON-RPC request.submit SyncEvent
    AdminSock->>Dispatcher: parse and validate envelope
    Dispatcher->>Requests: enqueue SyncEvent with RequestContext
    Requests->>Policy: pre-flight admission check
    alt sender/channel admitted
        Policy-->>Requests: allow
        Requests->>Monitoring: append pre-flight allow audit
        Requests->>Supervisor: acquire or reuse session
        Supervisor->>Pi: spawn or select worker
        Supervisor->>Pi: send prompt over stdin JSON
        Pi->>Ext: tool calls/events during run
        Ext->>AdminSock: authz/event frames over extension.sock
        AdminSock->>Policy: action authorization checks
        Policy-->>AdminSock: allow/deny verdicts
        AdminSock-->>Ext: authz_verdict
        Ext->>Monitoring: forwarded events/verdicts
        Pi-->>Supervisor: prompt response over stdout JSON
        Supervisor-->>Requests: agent response
        Requests-->>Dispatcher: SyncEvent completed
        Dispatcher-->>CLI: JSON-RPC result with response
        CLI-->>User: print response
    else denied
        Policy-->>Requests: deny
        Requests->>Monitoring: append pre-flight deny audit
        Requests-->>Dispatcher: policy denied
        Dispatcher-->>CLI: JSON-RPC error
        CLI-->>User: show error
    end
```

## Periodic Message

```mermaid
sequenceDiagram
    autonumber
    participant Scheduler as scheduler
    participant Intake as request.submit socket facade
    participant Dispatcher as input dispatcher
    participant Requests as requests-handler
    participant Policy as policy-control
    participant Supervisor as pi-agent-supervisor
    participant Pi as pi-agent session
    participant Monitoring as monitoring

    Scheduler->>Intake: submit PeriodicEvent
    Intake->>Dispatcher: parse and validate envelope
    Dispatcher->>Requests: enqueue PeriodicEvent
    Intake-->>Scheduler: accepted with request_id
    Requests->>Policy: pre-flight admission check
    alt admitted
        Policy-->>Requests: allow
        Requests->>Monitoring: append pre-flight allow audit
        Requests->>Supervisor: acquire or reuse session
        Supervisor->>Pi: send scheduled prompt/task
        Pi-->>Supervisor: completion/result
        Supervisor-->>Requests: completion status
        Requests->>Monitoring: append completion audit
    else denied
        Policy-->>Requests: deny
        Requests->>Monitoring: append pre-flight deny audit
    end
```

## Async Email Event

```mermaid
sequenceDiagram
    autonumber
    participant EmailApp as email app
    participant Intake as request.submit socket facade
    participant Dispatcher as input dispatcher
    participant Requests as requests-handler
    participant Policy as policy-control
    participant Supervisor as pi-agent-supervisor
    participant Pi as pi-agent session
    participant Monitoring as monitoring

    EmailApp->>Intake: submit AsyncEvent with email payload
    Intake->>Dispatcher: parse and validate envelope
    Dispatcher->>Requests: enqueue AsyncEvent
    Intake-->>EmailApp: accepted with request_id
    Requests->>Policy: pre-flight admission check
    alt admitted
        Policy-->>Requests: allow
        Requests->>Monitoring: append pre-flight allow audit
        Requests->>Supervisor: acquire or reuse session
        Supervisor->>Pi: send async prompt/task
        Pi-->>Supervisor: completion/result
        Supervisor-->>Requests: completion status
        Requests->>Monitoring: append completion audit
    else denied
        Policy-->>Requests: deny
        Requests->>Monitoring: append pre-flight deny audit
    end
```
