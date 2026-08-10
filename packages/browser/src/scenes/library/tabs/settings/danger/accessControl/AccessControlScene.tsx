import LibraryInclusions from './LibraryInclusions'

// TODO: add a section which shows the users not allowed to access the library from the tags
// This implies user:read permission

export default function AccessControlScene() {
	return (
		<div className="gap-12 flex flex-col">
			<LibraryInclusions />
		</div>
	)
}
