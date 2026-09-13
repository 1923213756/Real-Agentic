/** Worker owns detached sessions and must finish escalating them first. */
export const MANAGED_SESSION_SHUTDOWN_GRACE_MS = 1_500

/** Supervisor grace for each managed process group (Worker, Web, then RCS). */
export const STACK_CHILD_SHUTDOWN_GRACE_MS = 10_000

/** Briefly reap a process-group leader after escalating it to SIGKILL. */
export const STACK_FORCE_KILL_REAP_GRACE_MS = 1_000
