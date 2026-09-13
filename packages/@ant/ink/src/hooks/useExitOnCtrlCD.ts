/**
 * Minimal stub of useExitOnCtrlCD + useExitOnCtrlCDWithKeybindings.
 *
 * The original hooks depend on the keybinding system and useApp() exit.
 * This stub provides the same interface with simplified Ctrl+C/D handling
 * via useInput, suitable for the standalone @anthropic/ink package.
 */

import { useCallback, useState } from 'react'
import useInput from './use-input.js'

export type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

/**
 * Minimal double-press exit handler.
 * First Ctrl+C/D shows pending state, second press within timeout fires onExit.
 */
const DOUBLE_PRESS_TIMEOUT_MS = 800

function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
): () => void {
  let lastPress = 0
  let timeout: ReturnType<typeof setTimeout> | undefined

  return () => {
    const now = Date.now()
    const timeSince = now - lastPress
    const isDouble =
      timeSince <= DOUBLE_PRESS_TIMEOUT_MS && timeout !== undefined

    if (isDouble) {
      clearTimeout(timeout)
      timeout = undefined
      setPending(false)
      onDoublePress()
    } else {
      setPending(true)
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        setPending(false)
        timeout = undefined
      }, DOUBLE_PRESS_TIMEOUT_MS)
    }
    lastPress = now
  }
}

/**
 * Stub that provides ExitState for Ctrl+C/D double-press UI.
 * In the standalone package, this uses useInput directly rather than the
 * keybinding system.
 */
export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive: boolean = true,
): ExitState {
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })

  const exit = useCallback(() => {
    if (onExit) {
      onExit()
      return
    }
    // Let the application-level shutdown coordinator reap children. Keep the
    // standalone fallback for consumers that did not install signal handlers.
    if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT')
    else process.exit(0)
  }, [onExit])

  const handleCtrlC = useDoublePress(
    (pending: boolean) =>
      setExitState({ pending, keyName: pending ? 'Ctrl-C' : null }),
    exit,
  )

  const handleCtrlD = useDoublePress(
    (pending: boolean) =>
      setExitState({ pending, keyName: pending ? 'Ctrl-D' : null }),
    exit,
  )

  const handleInput = useCallback(
    (_input: string, key: { ctrl?: boolean; name?: string }) => {
      if (!isActive) return
      if (key.ctrl && key.name === 'c') {
        if (onInterrupt?.()) return
        handleCtrlC()
      } else if (key.ctrl && key.name === 'd') {
        handleCtrlD()
      }
    },
    [isActive, onInterrupt, handleCtrlC, handleCtrlD],
  )

  useInput(handleInput, { isActive })

  return exitState
}
