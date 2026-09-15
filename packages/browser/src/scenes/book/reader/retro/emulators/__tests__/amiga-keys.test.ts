import {
	AMIGA_KEY_CODES,
	isPhysicalJoystickCode,
	joystickCommand,
	overlayJoystickEvent,
	overlayKeyCode,
	physicalJoystickEvent,
} from '../amiga-keys'
import { containPoint, palDisplayHeight } from '../amiga-video'

describe('Amiga key codes', () => {
	it('maps a QWERTY row to Amiga raw codes', () => {
		expect(AMIGA_KEY_CODES.KeyQ).toBe(0x10)
		expect(AMIGA_KEY_CODES.Space).toBe(0x40)
		expect(AMIGA_KEY_CODES.Enter).toBe(0x44)
		expect(AMIGA_KEY_CODES.Escape).toBe(0x45)
		expect(AMIGA_KEY_CODES.MetaLeft).toBe(0x66)
	})

	it('maps overlay ids onto the same codes', () => {
		expect(overlayKeyCode('space')).toBe(AMIGA_KEY_CODES.Space)
		expect(overlayKeyCode('return')).toBe(AMIGA_KEY_CODES.Enter)
		expect(overlayKeyCode('runstop')).toBe(AMIGA_KEY_CODES.Escape)
		expect(overlayKeyCode('q')).toBe(AMIGA_KEY_CODES.KeyQ)
		expect(overlayKeyCode('tab')).toBe(AMIGA_KEY_CODES.Tab)
		expect(overlayKeyCode('alt')).toBe(AMIGA_KEY_CODES.AltLeft)
		expect(overlayKeyCode('help')).toBe(AMIGA_KEY_CODES.Help)
		expect(overlayKeyCode('bracketleft')).toBe(AMIGA_KEY_CODES.BracketLeft)
		expect(overlayKeyCode('cursorup')).toBe(AMIGA_KEY_CODES.ArrowUp)
	})
})

describe('joystick commands', () => {
	it('prefixes the port number the way vAmigaWeb expects', () => {
		expect(joystickCommand(2, 'PULL_UP')).toBe('2PULL_UP')
		expect(joystickCommand(1, 'PRESS_FIRE')).toBe('1PRESS_FIRE')
	})

	it('turns arrow keys into stick motion', () => {
		expect(physicalJoystickEvent('ArrowLeft', true)).toBe('PULL_LEFT')
		expect(physicalJoystickEvent('ArrowLeft', false)).toBe('RELEASE_X')
		expect(physicalJoystickEvent('ControlLeft', true)).toBe('PRESS_FIRE')
		expect(isPhysicalJoystickCode('ArrowUp')).toBe(true)
		expect(isPhysicalJoystickCode('KeyA')).toBe(false)
	})

	it('turns overlay stick ids into the same events', () => {
		expect(overlayJoystickEvent('up', true)).toBe('PULL_UP')
		expect(overlayJoystickEvent('fire', false)).toBe('RELEASE_FIRE')
		expect(overlayJoystickEvent('space', true)).toBeNull()
	})
})

describe('Amiga video', () => {
	it('scales framebuffer height for PAL pixels and TPP=2 texels', () => {
		expect(palDisplayHeight(256, false)).toBe(1024)
		expect(palDisplayHeight(200, true)).toBe(944)
	})

	it('maps a click through object-contain letterboxing', () => {
		expect(containPoint(160, 128, 320, 256, { left: 0, top: 0, width: 640, height: 512 })).toEqual({
			x: 80,
			y: 64,
		})
		expect(containPoint(10, 10, 320, 256, { left: 0, top: 0, width: 640, height: 640 })).toBeNull()
	})
})
