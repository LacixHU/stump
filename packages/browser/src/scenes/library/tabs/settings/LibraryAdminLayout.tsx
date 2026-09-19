import { UserPermission } from '@stump/graphql'
import { cx } from 'class-variance-authority'
import { Suspense, useEffect, useMemo } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'

import { SceneContainer } from '@/components/container'
import { useAppContext } from '@/context'
import { usePreferences } from '@/hooks'
import paths from '@/paths'

type Props = {
	applySceneDefaults?: boolean
}

/**
 *  Component that renders the layout for the library admin pages. This includes:
 */
export default function LibraryAdminLayout({ applySceneDefaults = true }: Props) {
	const { checkPermission } = useAppContext()
	const {
		preferences: { primaryNavigationMode },
	} = usePreferences()

	const navigate = useNavigate()
	const { id } = useParams()
	const canManage = useMemo(() => checkPermission(UserPermission.ManageLibrary), [checkPermission])
	useEffect(() => {
		if (!canManage) {
			// Note: a route-relative '..' resolves to /libraries here, since this is a pathless
			// route under the library's splat layout. That is an unimplemented stub page, so send
			// them back to the library itself instead.
			navigate(id ? paths.librarySeries(id) : paths.home())
		}
	}, [canManage, navigate, id])

	if (!canManage) {
		return null
	}

	const renderInner = () => {
		if (applySceneDefaults) {
			return (
				<SceneContainer
					className={cx('space-y-6 flex min-h-full w-full grow flex-col', {
						'max-w-4xl': primaryNavigationMode === 'SIDEBAR',
					})}
				>
					<Suspense>
						<Outlet />
					</Suspense>
				</SceneContainer>
			)
		} else {
			return (
				<Suspense>
					<Outlet />
				</Suspense>
			)
		}
	}

	return <div className="flex h-full w-full items-start justify-start">{renderInner()}</div>
}
