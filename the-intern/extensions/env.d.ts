/// <reference types="node" />

// Ambient declarations for the env-var contract defined in S-003.
// These variables are set by the bob service supervisor on every pi child process.
declare namespace NodeJS {
  interface ProcessEnv {
    /** The session id allocated by the bob service supervisor for this pi-agent process. */
    BOB_SESSION_ID?: string;
    /** Absolute path to the bob service's extension.sock UDS endpoint. */
    BOB_EXTENSION_SOCK_PATH?: string;
  }
}
