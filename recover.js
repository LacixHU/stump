const fs = require('fs')
const transcript = fs.readFileSync(
	'c:/Users/lhatv/AppData/Roaming/Code/User/workspaceStorage/1d2fd391af99b22094355de46cb4cc7f/GitHub.copilot-chat/transcripts/24db4d7e-418f-4001-abbf-97a35d1d00e8.jsonl',
	'utf8',
)

const lines = transcript.split('\n')
let bestContent = null
let foundAt = -1

for (let i = 0; i < lines.length; i++) {
	const line = lines[i]
	if (!line) continue
	try {
		const obj = JSON.parse(line)
		if (obj.tool_results && obj.tool_results.length > 0) {
			for (const res of obj.tool_results) {
				if (
					res.name === 'read_file' &&
					res.content &&
					res.content.includes('export default function NativePDFViewer')
				) {
					if (res.content.includes('PageThumbnailStrip')) {
						// Found a large read
						bestContent = res.content
						foundAt = i
					}
				}
			}
		}
	} catch (e) {}
}

if (bestContent) {
	console.log('Found backup at line', foundAt)
	// Wait, the read_file might be chunked.
} else {
	console.log('No backup found!')
}
