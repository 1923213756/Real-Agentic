import { describe, expect, test } from 'bun:test'
import {
  applyDirectoryError,
  applyListing,
  canConfirmWorkspace,
  createRemoteDirectoryState,
  enterDirectory,
  goBack,
  goToParent,
  requestPathInput,
  setPathInput,
} from '../lib/remote-directory-model'

describe('remote directory model', () => {
  test('does not carry trust approval to a different directory', () => {
    const trusted = applyListing(createRemoteDirectoryState('/workspace'), {
      path: '/workspace',
      trusted: true,
      entries: [{ name: 'src', kind: 'directory' }],
    })
    expect(trusted.trusted).toBe(true)
    expect(canConfirmWorkspace(setPathInput(trusted, '/not-reviewed'))).toBe(
      false,
    )
    const changed = requestPathInput(setPathInput(trusted, '/other'))
    expect(changed.trusted).toBeUndefined()
    expect(canConfirmWorkspace(changed)).toBe(false)
    expect(
      applyListing(changed, { path: '/other', trusted: false, entries: [] })
        .trusted,
    ).toBe(false)
  })
  test('enters directories but never files', () => {
    const state = applyListing(createRemoteDirectoryState('/workspace'), {
      path: '/workspace',
      entries: [
        { name: 'src', kind: 'directory' },
        { name: 'README.md', kind: 'file' },
      ],
    })

    expect(enterDirectory(state, 'src').requestedPath).toBe('/workspace/src')
    expect(enterDirectory(state, 'README.md')).toEqual(state)
  })

  test('supports typed paths, parent, back, errors, and validated confirmation', () => {
    const initial = applyListing(createRemoteDirectoryState('/workspace/src'), {
      path: '/real/workspace/src',
      entries: [],
    })
    expect(canConfirmWorkspace(initial)).toBe(true)

    const parent = goToParent(initial)
    expect(parent.requestedPath).toBe('/workspace')
    expect(goBack(parent).requestedPath).toBe('/workspace/src')

    const typed = requestPathInput(setPathInput(initial, '/other'))
    expect(typed.requestedPath).toBe('/other')
    expect(canConfirmWorkspace(typed)).toBe(false)
    expect(applyDirectoryError(typed, '不可读取').error).toBe('不可读取')
  })
})
