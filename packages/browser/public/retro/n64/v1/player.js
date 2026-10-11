/*
 * Stump's host page for N64Wasm (https://github.com/nbarkhina/N64Wasm, MIT).
 *
 * N64Wasm is built as a page-level singleton: a global `Module`, one `callMain`, and no way
 * to stop it (its own "new ROM" button reloads the page). Stump therefore runs it in an
 * iframe of its own and throws the iframe away to stop it, which also frees the 512 MB heap,
 * the WebGL context and the audio graph. `emulators/n64.ts` is the only caller of
 * `window.stumpN64`, and it lives in the same origin, so it calls straight in.
 *
 * Upstream's UI (index.html, script.js, input_controller.js) is not used. What the core needs
 * from a host page is small, and is all that is reproduced here:
 *   - a `canvas` element and a `Module` object defined before n64wasm.js loads
 *   - `assets.zip`, `custom.v64`, `config.txt` and `cheat.txt` written into its filesystem
 *   - an audio ring buffer drained from a ScriptProcessor at 44.1 kHz
 *   - a `myApp` object the compiled code calls back into (EM_ASM), above all
 *     `rivetsData.inputController.updateMobileControls()`, once per frame
 *
 * Input goes in through the core's "mobile" path, so the core never looks at a keyboard or
 * gamepad itself: the host says which buttons are down and where the analog stick is, once
 * a frame. That keeps one code path for the overlay, the keyboard and a pad.
 *
 * The state/SRAM formats are the core's own: `/savestate.gz` for a snapshot and
 * `/game.savememory` for cartridge saves (EEPROM, SRAM, FlashRAM, Controller Pak).
 */
;(function () {
	'use strict'

	// The core reads a connected gamepad itself and then skips the host's input altogether
	// (`processMobileControls` only runs while it sees no pad), so keyboard and overlay would
	// go dead the moment a pad is plugged in, and its own pad mapping has no C buttons. The
	// host polls pads instead (`n64-keys.ts`), so this frame is told there are none. This has
	// to run before n64wasm.js, which is why it is the first thing here.
	try {
		Object.defineProperty(navigator, 'getGamepads', {
			configurable: true,
			value: function () {
				return []
			},
		})
	} catch (err) {
		// a browser that will not let it be replaced keeps the core's own pad handling
	}
	;['gamepadconnected', 'gamepaddisconnected'].forEach(function (type) {
		window.addEventListener(
			type,
			function (event) {
				event.stopImmediatePropagation()
			},
			true,
		)
	})

	var AUDIO_CHUNK = 1024
	var AUDIO_RING = 64000
	var SAMPLE_RATE = 44100 // must match the core (gui.cpp)
	var STATE_TIMEOUT_MS = 8000

	// Up, Down, Left, Right, A, B, Start, Z, L, R, C-Up, C-Down, C-Left, C-Right
	var BUTTON_ORDER = [
		'up',
		'down',
		'left',
		'right',
		'a',
		'b',
		'start',
		'z',
		'l',
		'r',
		'cup',
		'cdown',
		'cleft',
		'cright',
	]

	var buttons = {}
	BUTTON_ORDER.forEach(function (id) {
		buttons[id] = false
	})
	var stickX = 0
	var stickY = 0

	var running = false
	var destroyed = false
	var romName = ''
	var sendMobileControls = null
	var setRemainingAudio = null

	var audio = { ctx: null, node: null, gain: null, ring: null, read: 0 }

	var api = {
		onError: null,
		onStarted: null,
		// Counters and the last input sent, for diagnostics and the tests that drive this page
		stats: { frames: 0, audioChunks: 0, lastInput: '' },
	}

	function fail(message) {
		console.error('[n64]', message)
		if (typeof api.onError === 'function') api.onError(String(message))
	}

	// ---------------------------------------------------------------- core boot

	var runtimeReady = new Promise(function (resolve) {
		window.Module = {
			canvas: document.getElementById('canvas'),
			print: onPrint,
			printErr: function (text) {
				console.warn('[n64]', text)
			},
			onAbort: function (what) {
				running = false
				fail('The emulator stopped unexpectedly (' + what + ')')
			},
			onRuntimeInitialized: resolve,
		}
	})

	var script = document.createElement('script')
	script.src = 'n64wasm.js'
	script.onerror = function () {
		fail('Could not load the N64 emulator core')
	}
	document.head.appendChild(script)

	function onPrint(text) {
		// Cartridge saves are written by the core to its own filesystem; this is the cue to
		// copy them out. Anything else it prints is noise.
		if (typeof text === 'string' && text.indexOf('writing game.savememory') !== -1) {
			setTimeout(saveSram, 100)
		}
	}

	// Everything the compiled code reaches for on `window.myApp` (see EM_ASM in n64wasm.js).
	// The cloud save and fullscreen hooks belong to upstream's UI; Stump has its own.
	var pendingState = null
	window.myApp = {
		rivetsData: {
			inputController: { updateMobileControls: updateMobileControls },
		},
		SaveStateEvent: function () {
			if (!pendingState) return
			var done = pendingState
			pendingState = null
			clearTimeout(done.timer)
			try {
				done.resolve(FS.readFile('/savestate.gz'))
			} catch (err) {
				done.reject(err)
			}
		},
		ExportEepEvent: function () {},
		ExportSraEvent: function () {},
		ExportFlaEvent: function () {},
		localCallback: function () {},
		loadCloud: function () {},
		saveCloud: function () {},
		fullscreen: function () {},
	}

	function hasWebGL2() {
		try {
			var probe = document.createElement('canvas')
			return !!probe.getContext('webgl2')
		} catch (err) {
			return false
		}
	}

	// The core reads its settings positionally from config.txt, one value per line. The order
	// is upstream's `WriteConfigFile`; the control values are the ones its defaults carry and
	// do nothing here, because the host drives input (mobile mode = 1).
	function configText() {
		var lines = [
			// gamepad: up, down, left, right, A, B, start, Z, L, R, menu, C-left/right/up/down
			12, 13, 14, 15, 0, 2, 9, 4, 6, 5, 11, -1, -1, -1, -1,
			// keyboard: left, right, up, down, start, C-up/down/left/right, Z, L, R, B, A, menu,
			// analog up/down/left/right
			'b', 'n', 'y', 'h', 'Enter', 'i', 'k', 'j', 'l', 'a', 'q', 'e', 's', 'd', '`',
			'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
			// save files uploaded by hand (eep, sra, fla): none
			0, 0, 0,
			0, // show FPS
			0, // swap sticks
			1, // disable audio sync: the audio callback paces the core's own loop
			0, 0, 0, // invert Y for players 2-4
			1, // mobile mode: input arrives through `updateMobileControls`
			0, // Angrylion software renderer
			0, // mouse mode
			0, // VBO
			0, // Rice video plugin
		]
		return lines.join('\r\n') + '\r\n'
	}

	// ---------------------------------------------------------------- audio

	function initAudio() {
		if (audio.ctx) return
		audio.ctx = new (window.AudioContext || window.webkitAudioContext)({
			latencyHint: 'interactive',
			sampleRate: SAMPLE_RATE,
		})
		audio.gain = audio.ctx.createGain()
		audio.gain.gain.value = 0.5
		audio.gain.connect(audio.ctx.destination)
		audio.ring = new Int16Array(
			Module.HEAP16.buffer,
			Module._neilGetSoundBufferResampledAddress(),
			AUDIO_RING,
		)
		audio.read = 0
		audio.node = audio.ctx.createScriptProcessor(AUDIO_CHUNK, 2, 2)
		audio.node.onaudioprocess = drainAudio
		audio.node.connect(audio.gain)
	}

	function drainAudio(event) {
		if (!running) return
		api.stats.audioChunks++
		var left = event.outputBuffer.getChannelData(0)
		var right = event.outputBuffer.getChannelData(1)
		var write = Module._neilGetAudioWritePosition()
		var read = audio.read
		var ring = audio.ring

		for (var i = 0; i < AUDIO_CHUNK; i++) {
			if (write !== read) {
				left[i] = ring[read] / 32768
				right[i] = ring[read + 1] / 32768
				read += 2
				if (read === AUDIO_RING) read = 0
			} else {
				left[i] = 0
				right[i] = 0
			}
		}
		audio.read = read

		if (setRemainingAudio) {
			setRemainingAudio(((write - read) % AUDIO_RING + AUDIO_RING) % AUDIO_RING)
		}
	}

	// ---------------------------------------------------------------- input

	function updateMobileControls() {
		if (!sendMobileControls) return
		var flags = ''
		for (var i = 0; i < BUTTON_ORDER.length; i++) {
			flags += buttons[BUTTON_ORDER[i]] ? '1' : '0'
		}
		api.stats.frames++
		api.stats.lastInput = flags + ' ' + stickX + ' ' + stickY
		sendMobileControls(flags, String(stickX), String(stickY))
	}

	// ---------------------------------------------------------------- saves

	var DB_NAME = 'stump-n64'
	var STORE = 'cartridge'

	function openDb() {
		return new Promise(function (resolve, reject) {
			try {
				var req = indexedDB.open(DB_NAME, 1)
				req.onupgradeneeded = function () {
					req.result.createObjectStore(STORE)
				}
				req.onsuccess = function () {
					resolve(req.result)
				}
				req.onerror = function () {
					reject(req.error)
				}
			} catch (err) {
				reject(err)
			}
		})
	}

	function loadSram(name) {
		return openDb()
			.then(function (db) {
				return new Promise(function (resolve) {
					var req = db.transaction(STORE, 'readonly').objectStore(STORE).get(name)
					req.onsuccess = function () {
						if (req.result) FS.writeFile('/game.savememory', new Uint8Array(req.result))
						resolve()
					}
					req.onerror = function () {
						resolve()
					}
				})
			})
			.catch(function () {
				// no storage (private window): the game simply starts with an empty cartridge
			})
	}

	function saveSram() {
		if (!running) return
		var data
		try {
			data = FS.readFile('/game.savememory')
		} catch (err) {
			return
		}
		openDb()
			.then(function (db) {
				db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, romName)
			})
			.catch(function () {})
	}

	// ---------------------------------------------------------------- public api

	api.start = function (rom, name) {
		return runtimeReady.then(function () {
			if (destroyed) return
			if (!hasWebGL2()) throw new Error('WebGL2 is not available in this browser')
			romName = name || 'game'

			return fetch('assets.zip')
				.then(function (res) {
					if (!res.ok) throw new Error('Could not load the emulator assets')
					return res.arrayBuffer()
				})
				.then(function (assets) {
					if (destroyed) return
					FS.writeFile('assets.zip', new Uint8Array(assets))
					FS.writeFile('custom.v64', new Uint8Array(rom))
					FS.writeFile('config.txt', configText())
					FS.writeFile('cheat.txt', '')
					initAudio()
					return loadSram(romName)
				})
				.then(function () {
					if (destroyed) return
					sendMobileControls = Module.cwrap('neil_send_mobile_controls', null, [
						'string',
						'string',
						'string',
					])
					setRemainingAudio = Module.cwrap('neil_set_buffer_remaining', null, ['number'])
					running = true
					Module.callMain(['custom.v64'])
					if (typeof api.onStarted === 'function') api.onStarted()
				})
		})
	}

	api.setButton = function (id, down) {
		if (id in buttons) buttons[id] = !!down
	}

	// x: right is positive, y: up is positive, both -1..1
	api.setAxis = function (x, y) {
		stickX = Math.max(-1, Math.min(1, Number(x) || 0))
		stickY = Math.max(-1, Math.min(1, Number(y) || 0))
	}

	api.releaseAll = function () {
		BUTTON_ORDER.forEach(function (id) {
			buttons[id] = false
		})
		stickX = 0
		stickY = 0
	}

	api.reset = function () {
		if (running) Module._neil_reset()
	}

	api.resumeAudio = function () {
		if (audio.ctx && audio.ctx.state !== 'running') {
			audio.ctx.resume().catch(function () {})
		}
	}

	// The core serializes on its next frame and calls `SaveStateEvent`, so this is async.
	api.saveState = function () {
		return new Promise(function (resolve, reject) {
			if (!running) return reject(new Error('The emulator is not running'))
			if (pendingState) return reject(new Error('A save is already in progress'))
			try {
				FS.unlink('/savestate.gz')
			} catch (err) {}
			pendingState = {
				resolve: resolve,
				reject: reject,
				timer: setTimeout(function () {
					pendingState = null
					reject(new Error('The emulator did not produce a save state'))
				}, STATE_TIMEOUT_MS),
			}
			Module._neil_serialize()
		})
	}

	api.loadState = function (bytes) {
		if (!running) return Promise.reject(new Error('The emulator is not running'))
		FS.writeFile('/savestate.gz', new Uint8Array(bytes))
		Module._neil_unserialize()
		return Promise.resolve()
	}

	api.destroy = function () {
		destroyed = true
		running = false
		sendMobileControls = null
		setRemainingAudio = null
		try {
			if (audio.node) audio.node.disconnect()
			if (audio.ctx) audio.ctx.close()
		} catch (err) {}
		audio.node = null
		audio.ctx = null
	}

	window.stumpN64 = api
})()
