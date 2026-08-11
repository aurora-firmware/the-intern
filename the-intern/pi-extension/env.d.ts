/// <reference types="node" />

// Ambient declarations for the env-var contract defined in S-003 and S-004.
// BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH are set by the bob service
// supervisor on every pi child process.  BOB_AUTHZ_TIMEOUT_MS is an optional
// operator override for the policy-control verdict timeout.
// BOB_SKILL_INSTALL_PATH is an optional supervisor-set path used to answer
// pi's resources_discover event (S-011 / ADR-014).
declare namespace NodeJS {
  interface ProcessEnv {
    /** The session id allocated by the bob service supervisor for this pi-agent process. */
    BOB_SESSION_ID?: string;
    /** Absolute path to the bob service's extension.sock UDS endpoint. */
    BOB_EXTENSION_SOCK_PATH?: string;
    /**
     * Optional verdict timeout for the blocking tool_call authz hook, in
     * milliseconds.  When absent the built-in default (5000 ms) is used.
     * On timeout the hook fails closed: the tool call is blocked and one
     * warning is logged.
     */
    BOB_AUTHZ_TIMEOUT_MS?: string;
    /**
     * Optional absolute path to the bob service's resolved skill install
     * location. Set only when the supervisor has a non-empty resolved path
     * to supply. The extension answers pi's resources_discover event with
     * this path as a contributed skill path. When absent, empty, or naming a
     * path that does not exist on disk, the extension contributes no skill
     * paths and logs one warning — fail-open, not fail-closed like
     * BOB_SESSION_ID / BOB_EXTENSION_SOCK_PATH (S-011 / ADR-014).
     */
    BOB_SKILL_INSTALL_PATH?: string;
  }
}
