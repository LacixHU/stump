import { useLocaleContext } from '@stump/i18n'

import GenericFilterMultiselect from './GenericFilterMultiselect'

export default function ReadStatusSelect() {
	const { t } = useLocaleContext()

	return (
		<GenericFilterMultiselect
			name="read_status"
			label={t('common.readStatus')}
			options={[
				{
					label: t('common.completed'),
					value: 'finished',
				},
				{
					label: t('common.reading'),
					value: 'reading',
				},
				{
					label: t('common.unread'),
					value: 'not_started',
				},
			]}
		/>
	)
}
