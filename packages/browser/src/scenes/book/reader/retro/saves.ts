const DB_NAME = 'stump-retro-saves'
const STORE_NAME = 'saves'
const DB_VERSION = 1

export type RetroSaveSlot = {
	userId: string
	mediaId: string
	slot: number
	data: ArrayBuffer
	updatedAt: number
}

function saveKey(userId: string, mediaId: string, slot: number): string {
	return `stump-retro-save:${userId}:${mediaId}:${slot}`
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)
		request.onerror = () => reject(request.error)
		request.onsuccess = () => resolve(request.result)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME)
			}
		}
	})
}

export async function saveRetroState(
	userId: string,
	mediaId: string,
	slot: number,
	data: ArrayBuffer,
): Promise<void> {
	const db = await openDb()
	const key = saveKey(userId, mediaId, slot)
	const record: RetroSaveSlot = {
		userId,
		mediaId,
		slot,
		data,
		updatedAt: Date.now(),
	}
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite')
		tx.objectStore(STORE_NAME).put(record, key)
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error)
	})
}

export async function loadRetroState(
	userId: string,
	mediaId: string,
	slot: number,
): Promise<ArrayBuffer | null> {
	const db = await openDb()
	const key = saveKey(userId, mediaId, slot)
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readonly')
		const req = tx.objectStore(STORE_NAME).get(key)
		req.onsuccess = () => {
			const record = req.result as RetroSaveSlot | undefined
			resolve(record?.data ?? null)
		}
		req.onerror = () => reject(req.error)
	})
}

export async function listRetroSaveSlots(userId: string, mediaId: string): Promise<number[]> {
	const db = await openDb()
	const prefix = `stump-retro-save:${userId}:${mediaId}:`
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readonly')
		const req = tx.objectStore(STORE_NAME).getAllKeys()
		req.onsuccess = () => {
			const keys = (req.result as IDBValidKey[])
				.map(String)
				.filter((k) => k.startsWith(prefix))
				.map((k) => Number(k.slice(prefix.length)))
				.filter((n) => !Number.isNaN(n))
			resolve(keys)
		}
		req.onerror = () => reject(req.error)
	})
}
