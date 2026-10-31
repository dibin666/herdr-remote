// The small dialogs the file list's row menu opens: rename, delete and
// properties, all on the shared Modal.

import { useEffect, useRef, useState } from 'react';
import type { FsListEntry } from '@protocol/files';
import { isFsEntryName } from '@protocol/files';
import { useSettings } from '@/context/TerminalContext';
import { formatByteSize } from '@/features/paste/imagePaste';
import { Button } from '@/shared/ui/buttons';
import { Input } from '@/shared/ui/fields';
import { Modal } from '@/shared/ui/modal';
import { formatFsTime } from './fileList';

export function RenameDialog({
  entry,
  busy,
  onSubmit,
  onClose,
}: {
  entry: FsListEntry;
  busy: boolean;
  onSubmit: (newName: string) => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [name, setName] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the stem, not the extension: the part one usually keeps.
    const dot = entry.name.lastIndexOf('.');
    input.setSelectionRange(0, entry.kind === 'file' && dot > 0 ? dot : entry.name.length);
  }, [entry]);

  const valid = isFsEntryName(name) && name !== entry.name;
  const submit = () => {
    if (valid && !busy) onSubmit(name);
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t('files.renameTitle')}
      subtitle={entry.name}
      closeLabel={t('common.closeDialog')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!valid || busy}
            data-testid="files-rename-submit"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          aria-label={t('files.renameNewName')}
          spellCheck={false}
          autoComplete="off"
          data-testid="files-rename-input"
        />
      </form>
    </Modal>
  );
}

export function DeleteDialog({
  entry,
  busy,
  onConfirm,
  onClose,
}: {
  entry: FsListEntry;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const label = `${entry.name}${entry.kind === 'dir' ? '/' : ''}`;
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t('files.deleteTitle')}
      subtitle={label}
      closeLabel={t('common.closeDialog')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={busy}
            data-testid="files-delete-confirm"
          >
            {t('files.menuDelete')}
          </Button>
        </>
      }
    >
      <p className="px-1 py-2 text-tui text-tui-text">
        {entry.kind === 'dir'
          ? t('files.deleteDirBody', { name: label })
          : t('files.deleteFileBody', { name: label })}
      </p>
    </Modal>
  );
}

export function PropertiesDialog({
  entry,
  cwd,
  onClose,
}: {
  entry: FsListEntry;
  cwd: string;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const rows: Array<[string, string]> = [
    [t('files.propName'), entry.name],
    [t('files.propPath'), `${cwd.replace(/\/$/, '')}/${entry.name}`],
    [t('files.propType'), entry.kind === 'dir' ? t('files.propDir') : t('files.propFile')],
    [t('files.propSize'), entry.kind === 'dir' ? '—' : formatByteSize(entry.size)],
    [t('files.propMtime'), formatFsTime(entry.mtimeMs)],
  ];
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t('files.propertiesTitle')}
      subtitle={entry.name}
      closeLabel={t('common.closeDialog')}
      size="sm"
    >
      <dl className="px-1 py-2 text-tui">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 py-0.5">
            <dt className="w-[7em] shrink-0 text-tui-muted">{label}</dt>
            <dd className="min-w-0 break-all text-tui-text">{value}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
