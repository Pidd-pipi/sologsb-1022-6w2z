import { tokenizeText } from './data';
import { clone } from './editor';
import type {
  Annotation,
  AnnotationPackage,
  Chapter,
  ImportedPackageRecord,
  MergePendingItem,
  MergeResolution,
  Sentence,
  TextDocument,
  TextToken
} from './types';

function hashString(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function computeBaseDigest(document: TextDocument): string {
  const base = document.snapshots[0];
  if (!base) return '';
  return hashString(JSON.stringify({ chapters: base.chapters, annotations: base.annotations }));
}

export function createPackageId(): string {
  return `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPendingId(): string {
  return `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface LocatedSentence {
  chapter: Chapter;
  sentence: Sentence;
}

function findSentence(doc: TextDocument, sentenceId: string): LocatedSentence | undefined {
  for (const chapter of doc.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (sentence) return { chapter, sentence };
  }
  return undefined;
}

interface LocatedToken {
  chapter: Chapter;
  sentence: Sentence;
  token: TextToken;
}

function findToken(doc: TextDocument, tokenId: string): LocatedToken | undefined {
  for (const chapter of doc.chapters) {
    for (const sentence of chapter.sentences) {
      const token = sentence.tokens.find((item) => item.id === tokenId);
      if (token) return { chapter, sentence, token };
    }
  }
  return undefined;
}

function annotationTargetLabel(document: TextDocument, annotation: Annotation): string {
  if (annotation.anchorType === 'chapter') {
    return document.chapters.find((chapter) => chapter.id === annotation.anchorId)?.title ?? '未知章节';
  }
  for (const chapter of document.chapters) {
    if (annotation.anchorType === 'sentence') {
      const sentence = chapter.sentences.find((item) => item.id === annotation.anchorId);
      if (sentence) return `${chapter.title} · 第 ${sentence.order} 句`;
    } else {
      for (const sentence of chapter.sentences) {
        const token = sentence.tokens.find((item) => item.id === annotation.anchorId);
        if (token) return `${chapter.title} · “${token.text.trim()}”`;
      }
    }
  }
  return '引用目标待确认';
}

function pendingWordCitation(
  document: TextDocument,
  annotation: Annotation,
  sentenceId: string,
  tokenText: string,
  impact: string
): MergePendingItem {
  const located = findSentence(document, sentenceId);
  return {
    id: createPendingId(),
    kind: 'word-citation',
    status: 'pending',
    anchorId: annotation.anchorId,
    anchorType: 'word',
    annotationId: annotation.id,
    sentenceId,
    chapterId: located?.chapter.id,
    targetLabel: annotationTargetLabel(document, annotation),
    impact,
    tokenText,
    createdAt: new Date().toISOString()
  };
}

interface ReconcileResult {
  reanchored: number;
  pending: number;
}

function reconcileCitations(
  document: TextDocument,
  baseAnnotations: Map<string, Annotation>,
  remote: TextDocument | undefined
): ReconcileResult {
  let reanchored = 0;
  let pending = 0;
  const pendingItems: MergePendingItem[] = [...(document.mergePending ?? [])];

  for (const annotation of document.annotations) {
    if (annotation.anchorType !== 'word') continue;
    if (findToken(document, annotation.anchorId)) continue;

    const existing = pendingItems.find(
      (item) => item.kind === 'word-citation' && item.annotationId === annotation.id && item.status === 'pending'
    );
    let intended = findIntendedToken(document, remote, baseAnnotations, annotation);
    if (!intended && existing?.tokenText && existing.sentenceId) {
      intended = { sentenceId: existing.sentenceId, tokenText: existing.tokenText };
    }
    if (!intended) continue;

    const located = findSentence(document, intended.sentenceId);

    if (!located) {
      pending += 1;
      if (existing) {
        existing.impact = `词级引用“${intended.tokenText}”所属句子在合并后的正文中不存在，引用无法落点，需人工确认。`;
      } else {
        const created = pendingWordCitation(
          document,
          annotation,
          intended.sentenceId,
          intended.tokenText,
          `词级引用“${intended.tokenText}”所属句子在合并后的正文中不存在，引用无法落点，需人工确认。`
        );
        pendingItems.push(created);
        document.mergePending = pendingItems;
      }
      continue;
    }

    const match = located.sentence.tokens.find((token) => token.text.trim() === intended.tokenText);
    if (match) {
      annotation.anchorId = match.id;
      reanchored += 1;
      if (existing) {
        existing.status = 'resolved';
        existing.resolution = 'remote';
        existing.resolvedAt = new Date().toISOString();
        existing.impact = `已按合并后正文重算落点为“${match.text.trim()}”。`;
      }
      continue;
    }

    pending += 1;
    if (existing) {
      existing.impact = `词语“${intended.tokenText}”在修订后的句子中无对应落点，词级引用暂悬。确认后可迁移到所属句，引用精度由词语降为句子。`;
    } else {
      const created = pendingWordCitation(
        document,
        annotation,
        intended.sentenceId,
        intended.tokenText,
        `词语“${intended.tokenText}”在修订后的句子中无对应落点，词级引用暂悬。确认后可迁移到所属句，引用精度由词语降为句子。`
      );
      pendingItems.push(created);
      document.mergePending = pendingItems;
    }
  }

  return { reanchored, pending };
}

function findIntendedToken(
  document: TextDocument,
  remote: TextDocument | undefined,
  baseAnnotations: Map<string, Annotation>,
  annotation: Annotation
): { sentenceId: string; tokenText: string } | undefined {
  const base = baseAnnotations.get(annotation.id);
  if (base && base.anchorType === 'word') {
    for (const chapter of document.snapshots[0]?.chapters ?? []) {
      for (const sentence of chapter.sentences) {
        const token = sentence.tokens.find((item) => item.id === base.anchorId);
        if (token && token.text.trim()) return { sentenceId: sentence.id, tokenText: token.text.trim() };
      }
    }
  }
  if (remote) {
    const remoteFound = findToken(remote, annotation.anchorId);
    if (remoteFound && remoteFound.token.text.trim()) {
      return { sentenceId: remoteFound.sentence.id, tokenText: remoteFound.token.text.trim() };
    }
  }
  const localFound = findToken(document, annotation.anchorId);
  if (localFound && localFound.token.text.trim()) {
    return { sentenceId: localFound.sentence.id, tokenText: localFound.token.text.trim() };
  }
  return undefined;
}

export interface MergeOutcome {
  ok: boolean;
  note?: string;
  error?: string;
  stats?: {
    newAnnotations: number;
    updatedAnnotations: number;
    disputes: number;
    pendingCitations: number;
    pendingTotal: number;
  };
}

export function mergePackageIntoDocument(
  source: TextDocument,
  pkg: AnnotationPackage
): { document: TextDocument; outcome: MergeOutcome } {
  const document = clone(source);
  const localDigest = computeBaseDigest(document);
  if (pkg.baseDigest !== localDigest) {
    return {
      document: source,
      outcome: {
        ok: false,
        error: '批注包底本与本机底本不一致，为避免整份覆盖，已保留本机草稿，本次导入未生效。'
      }
    };
  }

  const already = document.importedPackages?.some((item) => item.packageId === pkg.packageId);
  if (already) {
    return {
      document: source,
      outcome: { ok: true, note: '该批注包已导入过，重复导入不重复生效，本机草稿未改动。' }
    };
  }

  const baseSnapshot = document.snapshots[0];
  const baseChapters = new Map<string, LocatedSentence>();
  const baseAnnotations = new Map<string, Annotation>();
  if (baseSnapshot) {
    for (const chapter of baseSnapshot.chapters) {
      for (const sentence of chapter.sentences) baseChapters.set(sentence.id, { chapter, sentence });
    }
    for (const annotation of baseSnapshot.annotations) baseAnnotations.set(annotation.id, annotation);
  }

  const remote = pkg.document;
  const remoteAnnotations = new Map<string, Annotation>(remote.annotations.map((item) => [item.id, item]));
  const newPending: MergePendingItem[] = [];
  let newAnnotations = 0;
  let updatedAnnotations = 0;
  let disputes = 0;

  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      const base = baseChapters.get(sentence.id);
      const remoteSentence = findSentence(remote, sentence.id);
      if (!base || !remoteSentence) continue;
      const baseText = base.sentence.text;
      const localText = sentence.text;
      const remoteText = remoteSentence.sentence.text;
      if (localText === baseText && remoteText !== baseText) {
        sentence.text = remoteText;
        sentence.tokens = tokenizeText(remoteText, sentence.id, sentence.tokens);
      } else if (localText !== baseText && remoteText !== baseText && localText !== remoteText) {
        disputes += 1;
        newPending.push({
          id: createPendingId(),
          kind: 'sentence-text',
          status: 'pending',
          anchorId: sentence.id,
          anchorType: 'sentence',
          sentenceId: sentence.id,
          chapterId: chapter.id,
          targetLabel: `${chapter.title} · 第 ${sentence.order} 句`,
          baseValue: baseText,
          localValue: localText,
          remoteValue: remoteText,
          impact: '两边都修订了该句正文且内容不一致。已保留本机正文；确认采用远端正文后将按新文本重算词级引用。',
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  for (const remoteAnnotation of remote.annotations) {
    const baseAnnotation = baseAnnotations.get(remoteAnnotation.id);
    const localIndex = document.annotations.findIndex((item) => item.id === remoteAnnotation.id);
    const localAnnotation = localIndex >= 0 ? document.annotations[localIndex] : undefined;

    if (!baseAnnotation) {
      if (localAnnotation) {
        if (localAnnotation.body.trim() === remoteAnnotation.body.trim()) continue;
        disputes += 1;
        newPending.push({
          id: createPendingId(),
          kind: 'annotation-body',
          status: 'pending',
          anchorId: localAnnotation.anchorId,
          anchorType: localAnnotation.anchorType,
          annotationId: localAnnotation.id,
          targetLabel: annotationTargetLabel(document, localAnnotation),
          localValue: localAnnotation.body,
          remoteValue: remoteAnnotation.body,
          impact: '远端新增注释与本机新增注释 ID 相同且正文不一致。已保留本机正文；确认前不改动来源与引用。',
          createdAt: new Date().toISOString()
        });
      } else {
        document.annotations.push(clone(remoteAnnotation));
        newAnnotations += 1;
      }
      continue;
    }

    if (!localAnnotation) {
      if (remoteAnnotation.body.trim() === baseAnnotation.body.trim()) continue;
      disputes += 1;
      newPending.push({
        id: createPendingId(),
        kind: 'annotation-delete',
        status: 'pending',
        anchorId: remoteAnnotation.anchorId,
        anchorType: remoteAnnotation.anchorType,
        annotationId: remoteAnnotation.id,
        targetLabel: annotationTargetLabel(document, remoteAnnotation),
        baseValue: baseAnnotation.body,
        remoteValue: remoteAnnotation.body,
        payload: JSON.stringify(remoteAnnotation),
        impact: '远端修改了该注释而本机已删除。确认前保留本机删除状态；可恢复底本条文或按远端条文恢复。',
        createdAt: new Date().toISOString()
      });
      continue;
    }

    if (remoteAnnotation.body.trim() === baseAnnotation.body.trim()) continue;
    if (localAnnotation.body.trim() === baseAnnotation.body.trim()) {
      localAnnotation.body = remoteAnnotation.body;
      updatedAnnotations += 1;
      continue;
    }
    if (localAnnotation.body.trim() === remoteAnnotation.body.trim()) continue;
    disputes += 1;
    newPending.push({
      id: createPendingId(),
      kind: 'annotation-body',
      status: 'pending',
      anchorId: localAnnotation.anchorId,
      anchorType: localAnnotation.anchorType,
      annotationId: localAnnotation.id,
      targetLabel: annotationTargetLabel(document, localAnnotation),
      baseValue: baseAnnotation.body,
      localValue: localAnnotation.body,
      remoteValue: remoteAnnotation.body,
      impact: '两边都改写了该注释正文且内容不一致。已保留本机正文；确认前不改动来源与引用。',
      createdAt: new Date().toISOString()
    });
  }

  for (const baseAnnotation of baseAnnotations.values()) {
    if (remoteAnnotations.has(baseAnnotation.id)) continue;
    const localAnnotation = document.annotations.find((item) => item.id === baseAnnotation.id);
    if (!localAnnotation) continue;
    if (localAnnotation.body.trim() === baseAnnotation.body.trim()) {
      document.annotations = document.annotations.filter((item) => item.id !== baseAnnotation.id);
      for (const item of document.annotations) {
        item.references = item.references.filter((id) => id !== baseAnnotation.id);
      }
    } else {
      disputes += 1;
      newPending.push({
        id: createPendingId(),
        kind: 'annotation-delete',
        status: 'pending',
        anchorId: localAnnotation.anchorId,
        anchorType: localAnnotation.anchorType,
        annotationId: localAnnotation.id,
        targetLabel: annotationTargetLabel(document, localAnnotation),
        baseValue: baseAnnotation.body,
        localValue: localAnnotation.body,
        payload: JSON.stringify(baseAnnotation),
        impact: '远端删除了该注释而本机有修改。已保留本机注释；确认前不改动来源与引用。',
        createdAt: new Date().toISOString()
      });
    }
  }

  document.mergePending = [...(document.mergePending ?? []), ...newPending];
  const reconciled = reconcileCitations(document, baseAnnotations, remote);

  const record: ImportedPackageRecord = {
    packageId: pkg.packageId,
    deviceId: pkg.deviceId,
    importedAt: new Date().toISOString()
  };
  document.importedPackages = [...(document.importedPackages ?? []), record];
  document.updatedAt = new Date().toISOString();

  const pendingTotal = (document.mergePending ?? []).filter((item) => item.status === 'pending').length;
  return {
    document,
    outcome: {
      ok: true,
      stats: {
        newAnnotations,
        updatedAnnotations,
        disputes,
        pendingCitations: reconciled.pending,
        pendingTotal
      }
    }
  };
}

export function resolveMergePending(
  source: TextDocument,
  pendingId: string,
  resolution: MergeResolution
): { document: TextDocument; outcome: string } {
  const document = clone(source);
  const item = document.mergePending?.find((pending) => pending.id === pendingId);
  if (!item || item.status === 'resolved') {
    return { document: source, outcome: '未找到待决项，或该事项已处理。' };
  }

  const baseSnapshot = document.snapshots[0];
  const baseAnnotation = item.annotationId
    ? baseSnapshot?.annotations.find((annotation) => annotation.id === item.annotationId)
    : undefined;

  if (item.kind === 'annotation-body') {
    const annotation = document.annotations.find((candidate) => candidate.id === item.annotationId);
    if (annotation) {
      if (resolution === 'remote' && item.remoteValue !== undefined) annotation.body = item.remoteValue;
      else if (resolution === 'base' && item.baseValue !== undefined) annotation.body = item.baseValue;
    }
    item.status = 'resolved';
    item.resolution = resolution;
    item.resolvedAt = new Date().toISOString();
    return { document, outcome: '已按所选内容解决正文争议，来源与引用未改动。' };
  }

  if (item.kind === 'sentence-text') {
    const sentence = item.sentenceId ? findSentence(document, item.sentenceId) : undefined;
    if (sentence) {
      const nextText =
        resolution === 'remote' && item.remoteValue !== undefined
          ? item.remoteValue
          : resolution === 'base' && item.baseValue !== undefined
            ? item.baseValue
            : item.localValue ?? sentence.sentence.text;
      sentence.sentence.text = nextText;
      sentence.sentence.tokens = tokenizeText(nextText, sentence.sentence.id, sentence.sentence.tokens);
    }
    item.status = 'resolved';
    item.resolution = resolution;
    item.resolvedAt = new Date().toISOString();
    const baseAnnotations = new Map<string, Annotation>(
      (baseSnapshot?.annotations ?? []).map((annotation) => [annotation.id, annotation])
    );
    const reconciled = reconcileCitations(document, baseAnnotations, undefined);
    return {
      document,
      outcome: `已按所选底本修订正文，并重算词级引用落点：${reconciled.reanchored} 条重新锚定，${reconciled.pending} 条仍待确认。`
    };
  }

  if (item.kind === 'annotation-delete') {
    const existing = document.annotations.find((candidate) => candidate.id === item.annotationId);
    if (existing) {
      if (resolution === 'remote') {
        document.annotations = document.annotations.filter((candidate) => candidate.id !== item.annotationId);
        for (const candidate of document.annotations) {
          candidate.references = candidate.references.filter((id) => id !== item.annotationId);
        }
        item.status = 'resolved';
        item.resolution = resolution;
        item.resolvedAt = new Date().toISOString();
        return { document, outcome: '已按远端删除该注释，并清理其他注释对它的引用。' };
      }
      if (resolution === 'base' && item.baseValue !== undefined) {
        existing.body = item.baseValue;
      }
      item.status = 'resolved';
      item.resolution = resolution;
      item.resolvedAt = new Date().toISOString();
      return { document, outcome: '已保留本机注释，来源与引用未改动。' };
    }

    if (resolution === 'local') {
      item.status = 'resolved';
      item.resolution = resolution;
      item.resolvedAt = new Date().toISOString();
      return { document, outcome: '已确认保持本机删除状态，未恢复注释。' };
    }
    const restored = item.payload ? (JSON.parse(item.payload) as Annotation) : baseAnnotation;
    if (restored) {
      document.annotations.push(clone(restored));
    }
    item.status = 'resolved';
    item.resolution = resolution;
    item.resolvedAt = new Date().toISOString();
    return { document, outcome: '已恢复注释条文，正文引用关系保持不变。' };
  }

  if (item.kind === 'word-citation') {
    const annotation = document.annotations.find((candidate) => candidate.id === item.annotationId);
    if (annotation) {
      if (resolution === 'migrate-sentence' && item.sentenceId) {
        annotation.anchorId = item.sentenceId;
        annotation.anchorType = 'sentence';
      }
    }
    item.status = 'resolved';
    item.resolution = resolution;
    item.resolvedAt = new Date().toISOString();
    return {
      document,
      outcome:
        resolution === 'migrate-sentence'
          ? '已将词级引用迁移到所属句，引用精度由词语降为句子。'
          : '已确认保留当前引用状态，影响已知悉。'
    };
  }

  return { document: source, outcome: '未知待决事项类型。' };
}
