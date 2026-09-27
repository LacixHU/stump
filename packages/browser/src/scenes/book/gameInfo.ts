/**
 * The first few platforms and how many more there are. Doom lists eighteen, and the one
 * line has to fit a dialog.
 */
export function summarizePlatforms(platforms: string[], max = 4): string {
	if (platforms.length <= max) return platforms.join(', ')
	return `${platforms.slice(0, max).join(', ')} +${platforms.length - max}`
}
