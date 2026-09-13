export const MAX_USER_MESSAGE_CHARS = 256 * 1024
export const MAX_WEB_EVENT_BODY_BYTES = 4 * 1024 * 1024

function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true
    }
  }
  return false
}

export type UserMessageValidationError =
  | {
      type: 'invalid_message'
      message: string
    }
  | {
      type: 'message_too_large'
      message: string
    }

function collectTextContent(value: unknown, texts: string[]): void {
  if (typeof value === 'string') {
    texts.push(value)
    return
  }
  if (!Array.isArray(value)) return
  for (const block of value) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      texts.push(record.text)
    }
  }
}

/**
 * Validate every supported text carrier in a browser user-message envelope.
 * The web client intentionally duplicates content in `content` and
 * `message.content` for compatibility, so each carrier is checked separately
 * rather than summing them and rejecting an otherwise valid message twice.
 */
export function validateUserMessagePayload(
  payload: unknown,
): UserMessageValidationError | undefined {
  const texts: string[] = []
  if (typeof payload === 'string') {
    texts.push(payload)
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    collectTextContent(record.content, texts)
    const message = record.message
    if (message && typeof message === 'object') {
      collectTextContent((message as Record<string, unknown>).content, texts)
    }
  }

  for (const text of texts) {
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      return {
        type: 'message_too_large',
        message: `Message exceeds the ${MAX_USER_MESSAGE_CHARS}-character limit`,
      }
    }
    if (hasDisallowedControlCharacter(text)) {
      return {
        type: 'invalid_message',
        message: 'Message contains unsupported control characters',
      }
    }
  }
  return undefined
}
