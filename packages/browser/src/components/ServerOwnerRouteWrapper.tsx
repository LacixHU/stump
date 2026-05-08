import { Navigate, Outlet } from 'react-router'

import { useAppContext } from '@/context/index.ts'

export default function ServerOwnerRouteWrapper() {
	const { isServerOwner } = useAppContext()

	return isServerOwner ? <Outlet /> : <Navigate to=".." replace />
}
