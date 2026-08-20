import { Navigate } from 'react-router'

import { useSeriesContext } from './context'

export default function SeriesDefaultRedirect() {
	const { series } = useSeriesContext()

	const defaultRoute = (series.childCount ?? 0) > 0 ? 'series' : 'books'

	return <Navigate to={defaultRoute} replace />
}
