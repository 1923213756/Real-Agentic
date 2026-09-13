import { Writable, Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { WSContext } from 'hono/ws'
import { send, sendJsonRpcError } from './client-send.js'
import { cancelPendingPermissions, createClient } from './acp-client.js'
import { buildAgentEnv } from './permission-mode.js'
import { clients, getAgentConfig, logAgent } from './runtime-state.js'
import {
  registerManagedProcess,
  terminateProcessTree,
} from '../process-tree.js'
import {
  JSONRPC_INTERNAL_ERROR,
  type AgentCapabilities,
  type ClientState,
} from './types.js'

export async function handleConnect(ws: WSContext): Promise<void> {
  const state = clients.get(ws)
  if (!state) return

  const {
    command: AGENT_COMMAND,
    args: AGENT_ARGS,
    cwd: AGENT_CWD,
  } = getAgentConfig()

  // If already connected to a running agent, just resend status
  // This handles frontend reconnections without restarting the agent process
  // Check both .killed and .exitCode to detect crashed processes
  if (
    state.connection &&
    state.process &&
    !state.process.killed &&
    state.process.exitCode === null
  ) {
    logAgent.info('already connected, resending status')
    send(ws, 'status', {
      connected: true,
      agentInfo: state.agentInfo ?? { name: AGENT_COMMAND },
      capabilities: state.agentCapabilities,
      protocolVersion: state.protocolVersion,
    })
    return
  }

  // Kill existing process if any (only if not healthy)
  if (state.process) {
    cancelPendingPermissions(state)
    await terminateProcessTree(state.process.pid, process.platform !== 'win32')
    state.process = null
    state.connection = null
  }

  try {
    logAgent.info({ command: AGENT_COMMAND, args: AGENT_ARGS }, 'spawning')

    const agentProcess = spawn(AGENT_COMMAND, AGENT_ARGS, {
      cwd: AGENT_CWD,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...buildAgentEnv(),
        CLAUDE_CODE_MANAGED_PARENT_PID: String(process.pid),
      },
      detached: process.platform !== 'win32',
    })
    const unregisterManaged = registerManagedProcess(
      agentProcess.pid,
      process.platform !== 'win32',
    )

    state.process = agentProcess

    // Clean up state when agent process exits unexpectedly
    agentProcess.on('exit', code => {
      unregisterManaged()
      logAgent.info({ exitCode: code }, 'agent process exited')
      // Only clear if this is still the current process
      if (state.process === agentProcess) {
        state.process = null
        state.connection = null
        state.sessionId = null
      }
    })

    const input = Writable.toWeb(
      agentProcess.stdin!,
    ) as unknown as WritableStream<Uint8Array>
    const output = Readable.toWeb(
      agentProcess.stdout!,
    ) as unknown as ReadableStream<Uint8Array>

    const stream = acp.ndJsonStream(input, output)
    const connection = new acp.ClientSideConnection(
      _agent => createClient(ws, state),
      stream,
    )

    state.connection = connection

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // Forward the real client identity/capabilities (audit §8.7). Falls back
      // to the Zed defaults only when the client did not provide any.
      clientInfo: state.clientInfo,
      clientCapabilities: state.clientCapabilities,
    })

    // Pass the raw agentCapabilities through unchanged so present and future
    // capability fields (auth, terminal, ...) reach the client (audit §8.6).
    const agentCaps = initResult.agentCapabilities
    state.agentCapabilities = (agentCaps as AgentCapabilities | null) ?? null
    state.promptCapabilities = agentCaps?.promptCapabilities ?? null
    // Remember the negotiated protocolVersion + agentInfo so reconnects and
    // JSON-RPC initialize responses can forward them to the client (§8.13).
    state.protocolVersion = initResult.protocolVersion
    state.agentInfo =
      (initResult.agentInfo as ClientState['agentInfo'] | null | undefined) ??
      null

    logAgent.info(
      {
        protocolVersion: initResult.protocolVersion,
        loadSession: !!state.agentCapabilities?.loadSession,
        sessionList: !!state.agentCapabilities?.sessionCapabilities?.list,
        sessionResume: !!state.agentCapabilities?.sessionCapabilities?.resume,
        hasMcp: !!state.agentCapabilities?.mcpCapabilities,
      },
      'initialized',
    )

    send(ws, 'status', {
      connected: true,
      agentInfo: initResult.agentInfo,
      capabilities: state.agentCapabilities,
      // Surface the negotiated protocolVersion to downstream clients (audit §8.13).
      protocolVersion: initResult.protocolVersion,
    })

    connection.closed.then(() => {
      logAgent.info('connection closed')
      state.connection = null
      state.sessionId = null
      send(ws, 'status', { connected: false })
    })
  } catch (error) {
    cancelPendingPermissions(state)
    const failedProcess = state.process
    state.process = null
    state.connection = null
    if (failedProcess) {
      await terminateProcessTree(
        failedProcess.pid,
        process.platform !== 'win32',
      )
    }
    logAgent.error({ error: (error as Error).message }, 'connect failed')
    sendJsonRpcError(
      ws,
      state,
      null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to connect: ${(error as Error).message}`,
    )
  }
}

export async function handleDisconnect(ws: WSContext): Promise<void> {
  const state = clients.get(ws)
  if (!state) return

  if (state.process) {
    const child = state.process
    state.process = null
    await terminateProcessTree(child.pid, process.platform !== 'win32')
  }
  state.connection = null
  state.sessionId = null

  send(ws, 'status', { connected: false })
}
