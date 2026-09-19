import { Navigate, Outlet } from 'react-router'

import { useAppContext } from '@/context/index.ts'

type Props = {
	/**
	 * Where to send a user who isn't the server owner. Defaults to the entity the guarded
	 * settings belong to.
	 *
	 * Note the `.` below: this guard is a pathless route, so it contributes nothing to the
	 * resolved path and `.` lands on its parent layout (e.g. `/series/:id`). A `..` would pop
	 * that layout too and land on the collection root (`/series`), which is an unimplemented
	 * stub page.
	 */
	redirectTo?: string
}

export default function ServerOwnerRouteWrapper({ redirectTo }: Props) {
	const { isServerOwner } = useAppContext()

	if (isServerOwner) {
		return <Outlet />
	}

	return <Navigate to={redirectTo ?? '.'} replace />
}
