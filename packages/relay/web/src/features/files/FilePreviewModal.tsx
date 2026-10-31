// The read-only look at a file's text: the host read it and sent as much as
// its preview cap allows. Long lines do not wrap — code reads as it is.

import { useSettings } from '@/context/TerminalContext';
import { Spinner } from '@/shared/ui/meters';
import { Modal } from '@/shared/ui/modal';

export type PreviewView =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; text: string; truncated: boolean };

export function FilePreviewModal({
  name,
  view,
  onClose,
}: {
  name: string;
  view: PreviewView;
  onClose: () => void;
}) {
  const { t } = useSettings();
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t('files.previewTitle')}
      subtitle={name}
      closeLabel={t('common.closeDialog')}
      size="lg"
      className="min-h-[16rem]"
    >
      {view.state === 'loading' ? (
        <div className="flex items-center justify-center gap-2 px-1 py-8 text-tui text-tui-faint">
          <Spinner />
          <span>{t('files.loading')}</span>
        </div>
      ) : view.state === 'error' ? (
        <p className="px-1 py-4 text-tui text-tui-bad" data-testid="files-preview-error">
          {view.message}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {view.truncated ? (
            <p className="px-1 text-tui-sm text-tui-faint">{t('files.previewTruncated')}</p>
          ) : null}
          <pre
            className="overflow-auto whitespace-pre px-1 py-2 font-mono text-tui text-tui-text"
            data-testid="files-preview-content"
          >
            {view.text}
          </pre>
        </div>
      )}
    </Modal>
  );
}
