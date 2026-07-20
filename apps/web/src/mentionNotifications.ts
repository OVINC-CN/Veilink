import type { RichNode, RichTextDocument } from './models'
import type { Preferences } from './preferences'
import { t } from './i18n'

export type MentionNotificationAvailability = NotificationPermission | 'unsupported'

export function mentionNotificationAvailability(): MentionNotificationAvailability {
  if (typeof window === 'undefined' || !window.isSecureContext || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

export async function requestMentionNotificationPermission(): Promise<MentionNotificationAvailability> {
  if (mentionNotificationAvailability() === 'unsupported') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

function containsMention(node: RichNode, memberId: string): boolean {
  if (node.type === 'mention' && node.attrs?.id === memberId) return true
  return node.content?.some((child) => containsMention(child, memberId)) ?? false
}

export function documentMentionsMember(document: RichTextDocument, memberId: string): boolean {
  return containsMention(document, memberId)
}

export function notifyMention(preferences: Preferences): void {
  if (
    !preferences.mentionNotifications ||
    mentionNotificationAvailability() !== 'granted' ||
    (document.visibilityState === 'visible' && document.hasFocus())
  ) return

  try {
    const notification = new Notification('Veilink', {
      body: t(preferences.locale, 'notificationReceived'),
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch {
    // Browser notifications are best-effort and never block message delivery.
  }
}
