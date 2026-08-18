import { Alert, AlertDescription, AlertTitle, ConfirmationModal } from '@stump/components'
import { useLocaleContext } from '@stump/i18n'
import { AlertTriangle } from 'lucide-react'

type Props = {
	isOpen: boolean
	onCancel: () => void
	onConfirm: () => void
}

export default function DeleteHistoryConfirmation({ isOpen, onCancel, onConfirm }: Props) {
	const { t } = useLocaleContext()

	return (
		<ConfirmationModal
			title={t('bookActions.deleteHistoryModal.title')}
			description={t('bookActions.deleteHistoryModal.description')}
			confirmText={t('common.delete')}
			cancelText={t('common.cancel')}
			isOpen={isOpen}
			onClose={onCancel}
			onConfirm={onConfirm}
			confirmVariant="destructive"
		>
			<Alert>
				<AlertTriangle />
				<AlertTitle>{t('common.thisCannotBeUndone')}</AlertTitle>
				<AlertDescription>{t('bookActions.deleteHistoryModal.cannotRecover')}</AlertDescription>
			</Alert>
		</ConfirmationModal>
	)
}
