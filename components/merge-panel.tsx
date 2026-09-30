'use client';

import { Button, Card, CardBody, Chip, Divider } from '@heroui/react';
import {
  AlertTriangle,
  Check,
  FileDown,
  FileUp,
  GitMerge,
  Import,
  ShieldAlert,
  Undo2
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { MergePendingItem, MergeResolution, TextDocument } from '@/lib/types';

interface MergePanelProps {
  document: TextDocument;
  message: { ok: boolean; text: string } | null;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onResolve: (pendingId: string, resolution: MergeResolution) => void;
}

const kindCopy: Record<MergePendingItem['kind'], { label: string; color: 'danger' | 'warning' | 'secondary' }> = {
  'annotation-body': { label: '正文争议', color: 'danger' },
  'annotation-delete': { label: '删改争议', color: 'danger' },
  'sentence-text': { label: '正文改动争议', color: 'warning' },
  'word-citation': { label: '引用待确认', color: 'secondary' }
};

function ValueBlock({ label, value, tone }: { label: string; value?: string; tone: 'base' | 'local' | 'remote' }) {
  if (value === undefined || value === '') return null;
  const toneClass =
    tone === 'local'
      ? 'border-amber-200 bg-amber-50/60'
      : tone === 'remote'
        ? 'border-blue-200 bg-blue-50/60'
        : 'border-stone-200 bg-stone-50';
  return (
    <div className={`rounded-lg border p-2 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-stone-700">{value}</p>
    </div>
  );
}

function PendingCard({ item, onResolve }: { item: MergePendingItem; onResolve: (resolution: MergeResolution) => void }) {
  const copy = kindCopy[item.kind];
  return (
    <Card shadow="none" className="border border-stone-200">
      <CardBody className="gap-3 p-3">
        <div className="flex items-center gap-2">
          <Chip size="sm" color={copy.color} variant="flat">{copy.label}</Chip>
          <span className="truncate text-xs text-stone-500">{item.targetLabel}</span>
        </div>

        {item.kind === 'word-citation' ? (
          <div className="flex gap-2 rounded-lg bg-stone-50 p-2 text-xs leading-5 text-stone-600">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" />
            <span>{item.impact}</span>
          </div>
        ) : (
          <div className="space-y-2">
            <ValueBlock label="底本" value={item.baseValue} tone="base" />
            <ValueBlock label="本机" value={item.localValue} tone="local" />
            <ValueBlock label="远端" value={item.remoteValue} tone="remote" />
            <div className="flex gap-2 rounded-lg bg-stone-50 p-2 text-xs leading-5 text-stone-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" />
              <span>{item.impact}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {item.kind === 'annotation-body' ? (
            <>
              <Button size="sm" color="warning" variant="flat" onPress={() => onResolve('local')}>保留本机</Button>
              <Button size="sm" color="primary" variant="flat" onPress={() => onResolve('remote')}>采用远端</Button>
              <Button size="sm" variant="light" onPress={() => onResolve('base')}>恢复底本</Button>
            </>
          ) : null}
          {item.kind === 'sentence-text' ? (
            <>
              <Button size="sm" color="warning" variant="flat" onPress={() => onResolve('local')}>保留本机正文</Button>
              <Button size="sm" color="primary" variant="flat" onPress={() => onResolve('remote')}>采用远端正文</Button>
              <Button size="sm" variant="light" onPress={() => onResolve('base')}>恢复底本</Button>
            </>
          ) : null}
          {item.kind === 'annotation-delete' ? (
            <>
              <Button size="sm" color="warning" variant="flat" onPress={() => onResolve('local')}>保留本机</Button>
              <Button size="sm" color="danger" variant="flat" onPress={() => onResolve('remote')}>按远端删除</Button>
              <Button size="sm" variant="light" onPress={() => onResolve('base')}>恢复底本条文</Button>
            </>
          ) : null}
          {item.kind === 'word-citation' ? (
            <>
              <Button size="sm" color="primary" variant="flat" onPress={() => onResolve('migrate-sentence')}>
                迁移到所属句
              </Button>
              <Button size="sm" variant="light" onPress={() => onResolve('keep')}>保留现状</Button>
            </>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

export function MergePanel({ document: doc, message, onExport, onImportFile, onResolve }: MergePanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState('');
  const pending = (doc.mergePending ?? []).filter((item) => item.status === 'pending');
  const imported = doc.importedPackages ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-stone-200 p-3">
        <h3 className="flex items-center gap-2 font-semibold text-stone-900">
          <GitMerge className="h-4 w-4" />批注包离线合并
        </h3>
        <p className="mt-2 text-xs leading-5 text-stone-500">
          批注包携带共同底本摘要。两台设备断网增补后，先导出本机批注包，再在本机导入对方的批注包：
          只并入实际改动，同目标同类型的正文争议列为待决，确认前不动来源与引用；词级引用按正文重算落点。
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" color="primary" variant="flat" startContent={<FileUp className="h-4 w-4" />} onPress={onExport}>
          导出批注包
          </Button>
          <Button
            size="sm"
            variant="flat"
            startContent={<FileDown className="h-4 w-4" />}
            onPress={() => fileRef.current?.click()}
          >
            导入批注包
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setFileName(file.name);
              onImportFile(file);
            }
            event.target.value = '';
          }}
        />
        {fileName ? <p className="mt-2 truncate text-[11px] text-stone-400">已选择：{fileName}</p> : null}
      </div>

      {message ? (
        <div
          className={`flex gap-2 rounded-xl border p-3 text-xs leading-5 ${
            message.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {message.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      ) : null}

      <Divider />

      <div>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold text-stone-900">
            <ShieldAlert className="h-4 w-4" />待决事项
          </h3>
          <Chip size="sm" variant="flat" color={pending.length ? 'danger' : 'default'}>{pending.length}</Chip>
        </div>
        {pending.length ? (
          <div className="mt-3 space-y-2">
            {pending.map((item) => (
              <PendingCard key={item.id} item={item} onResolve={(resolution) => onResolve(item.id, resolution)} />
            ))}
          </div>
        ) : (
          <div className="mt-3 grid place-items-center rounded-xl border border-dashed border-green-200 bg-green-50 p-6 text-center">
            <Check className="h-6 w-6 text-green-600" />
            <p className="mt-2 text-xs font-medium text-green-800">没有待决争议，所有改动均已落定</p>
          </div>
        )}
      </div>

      <Divider />

      <div>
        <h3 className="flex items-center gap-2 font-semibold text-stone-900">
          <Import className="h-4 w-4" />已导入批注包
        </h3>
        {imported.length ? (
          <ul className="mt-2 space-y-1.5">
            {imported.map((record) => (
              <li key={record.packageId} className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                <Undo2 className="h-3.5 w-3.5 text-stone-400" />
                <span className="font-medium text-stone-800">{record.deviceId}</span>
                <span className="ml-auto text-stone-400">{new Date(record.importedAt).toLocaleString('zh-CN')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-stone-500">尚未导入其他设备的批注包。</p>
        )}
      </div>
    </div>
  );
}
