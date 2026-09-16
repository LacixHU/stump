import { useEffect } from 'react'

import {
	applyGamepadJoystick,
	hasGamepadApi,
	IDLE_GAMEPAD_JOYSTICK,
	listGamepads,
	readAllGamepads,
} from './gamepad'
import type { OverlayKeyId } from './keys'

type UseGamepadJoystickOptions = {
	/**
	 * When false the pad is ignored and anything it was holding is released. Keyboard-only
	 * input mode turns this off so arrows stay arrows instead of becoming a stick.
	 */
	enabled: boolean
	sendKey: (target: OverlayKeyId, down: boolean) => void
}

/**
 * Drive the running machine from a USB or Bluetooth gamepad, through the same `sendKey`
 * path the on-screen stick uses. The overlay is hidden on a desktop with a keyboard, which
 * is exactly where a pad is most useful, so this lives on the player rather than inside
 * `OnScreenControls`.
 */
export function useGamepadJoystick({ enabled, sendKey }: UseGamepadJoystickOptions) {
	useEffect(() => {
		if (!enabled || !hasGamepadApi()) return

		let raf = 0
		let prev = IDLE_GAMEPAD_JOYSTICK

		const apply = (next: typeof prev) => {
			applyGamepadJoystick(prev, next, sendKey)
			prev = next
		}

		const poll = () => {
			raf = requestAnimationFrame(poll)
			apply(readAllGamepads(listGamepads()))
		}

		const release = () => apply(IDLE_GAMEPAD_JOYSTICK)

		const onVisibility = () => {
			if (document.hidden) release()
		}

		const onGamepadEvent = () => apply(readAllGamepads(listGamepads()))

		// Firefox (and some Chromium builds) leave `getGamepads()` empty until these
		// listeners exist, even if a pad is already plugged in.
		window.addEventListener('gamepadconnected', onGamepadEvent)
		window.addEventListener('gamepaddisconnected', onGamepadEvent)
		document.addEventListener('visibilitychange', onVisibility)
		raf = requestAnimationFrame(poll)

		return () => {
			cancelAnimationFrame(raf)
			window.removeEventListener('gamepadconnected', onGamepadEvent)
			window.removeEventListener('gamepaddisconnected', onGamepadEvent)
			document.removeEventListener('visibilitychange', onVisibility)
			release()
		}
	}, [enabled, sendKey])
}
