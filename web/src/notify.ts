let audioCtx: AudioContext | null = null

/** 预警提示音（WebAudio 合成，无音频资源依赖） */
export function beep(): void {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const t0 = audioCtx.currentTime
    const tone = (freq: number, start: number, dur: number): void => {
      const osc = audioCtx!.createOscillator()
      const gain = audioCtx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + start)
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
      osc.connect(gain)
      gain.connect(audioCtx!.destination)
      osc.start(t0 + start)
      osc.stop(t0 + start + dur + 0.05)
    }
    tone(880, 0, 0.14)
    tone(1318, 0.16, 0.22)
  } catch {
    /* 浏览器可能拦截未交互前的音频，静默忽略 */
  }
}

export type NotificationPermissionState = NotificationPermission | 'unsupported'

export function notificationState(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function requestNotifications(): Promise<NotificationPermissionState> {
  if (notificationState() !== 'default') return notificationState()
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export function sysNotify(title: string, body: string): void {
  if (notificationState() !== 'granted') return
  try {
    new Notification(title, { body, tag: title })
  } catch {
    /* noop */
  }
}
