import { beforeEach, describe, expect, it } from 'vitest'
import {
  PREFERENCES_KEY,
  defaultPreferences,
  loadPreferences,
  savePreferences,
  type Preferences,
} from './preferences'

describe('preference persistence boundary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists only the explicit preference whitelist', () => {
    const untrusted = {
      ...defaultPreferences(),
      locale: 'en-US',
      theme: 'dark',
      defaultRoomMode: 'p2p',
      maxFileSizeMb: 99.6,
      sendShortcut: 'mod-enter',
      showTimestamps: false,
      density: 'compact',
      rememberNickname: true,
      nickname: 'Mira',
      roomId: 'must-not-persist',
      pin: '123456',
      linkSecret: 'must-not-persist',
      messageKey: 'must-not-persist',
      publicIp: '203.0.113.5',
      messages: [{ text: 'must-not-persist' }],
    } as unknown as Preferences

    const saved = savePreferences(untrusted)
    const persisted = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>

    expect(saved).toEqual({
      locale: 'en-US',
      theme: 'dark',
      maxFileSizeMb: 100,
      sendShortcut: 'mod-enter',
      showTimestamps: false,
      density: 'compact',
      rememberNickname: true,
      mentionNotifications: false,
      notificationPromptDismissed: false,
      nickname: 'Mira',
    })
    expect(persisted).toEqual(saved)
    expect(persisted).not.toHaveProperty('defaultRoomMode')
    expect(Object.keys(localStorage)).toEqual([PREFERENCES_KEY])
  })

  it('removes a remembered nickname as soon as remembering is disabled', () => {
    const remembered = savePreferences({
      ...defaultPreferences(),
      rememberNickname: true,
      nickname: 'River',
    })
    expect(remembered.nickname).toBe('River')

    const forgotten = savePreferences({ ...remembered, rememberNickname: false })
    const persisted = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>

    expect(forgotten).not.toHaveProperty('nickname')
    expect(persisted).not.toHaveProperty('nickname')
  })

  it('fails closed to defaults for malformed stored JSON', () => {
    localStorage.setItem(PREFERENCES_KEY, '{not-json')
    expect(loadPreferences()).toEqual(defaultPreferences())
  })
})
