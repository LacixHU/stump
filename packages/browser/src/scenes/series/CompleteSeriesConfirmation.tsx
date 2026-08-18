import { Alert, AlertTitle, ConfirmationModal } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { AlertTriangle } from 'lucide-react'

type Props = {
	isOpen: boolean
	onCancel: () => void
	onConfirm: () => void
}

export default function CompleteSeriesConfirmation({ isOpen, onCancel, onConfirm }: Props) {
	const { t } = useLocaleContext()

	return (
		<ConfirmationModal
			title={t('bookActions.markSeriesCompleted.title')}
			description={t('bookActions.markSeriesCompleted.description')}
			confirmText={t('common.confirm')}
			cancelText={t('common.cancel')}
			isOpen={isOpen}
			onClose={onCancel}
			onConfirm={onConfirm}
			confirmVariant="destructive"
		>
			<Alert>
				<AlertTriangle />
				<AlertTitle>{t('common.thisCannotBeUndone')}</AlertTitle>
			</Alert>
		</ConfirmationModal>
	)
}
