import { APIBase } from '../base'
import { createRouteURLHandler } from './utils'

const FIRMWARE_ROUTE = '/firmware'
const firmwareURL = createRouteURLHandler(FIRMWARE_ROUTE)

/**
 * Firmware/BIOS files for in-browser emulators (user-supplied under STUMP_FIRMWARE_DIR).
 */
export class FirmwareAPI extends APIBase {
	/**
	 * URL for a single firmware file by basename (e.g. Kickstart ROM).
	 */
	fileURL(fileName: string): string {
		return this.withServiceURL(firmwareURL(`/${encodeURIComponent(fileName)}`))
	}
}
