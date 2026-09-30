import { tokenizeText } from './data';
import type {
  Annotation,
  AnnotationPackage,
  Chapter,
  MergeBaseSnapshot,
  MergeDispute,
  MergeIssue,
  MergeResult,
  PendingAnchor,
  PendingDispute,
  Sentence,
  TextDocument
} from './types';

export const DEVICE_STORAGE_KEY = 'sologsb-1022/public-text-annotator/device-id/v1';
const PACKAGE_FORMAT = 'sologsb.annotation-package/v1';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function baseContent(chapters: Chapter[], annotations: Annotation[]) {
  return {
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      order: chapter.order,
      title: chapter.title,
      summary: chapter.summary,
      sentences: chapter.sentences.map((sentence) => ({
        id: sentence.id,
        order: sentence.order,
        text: sentence.text,
        tokens: sentence.tokens.map((token) => ({ id: token.id, text: token.text }))
      }))
    })),
    annotations: annotations.map(({ updatedAt: _updatedAt, conflictResolution: _resolution, originSentenceId: _sentence, originTokenText: _tokenText, originTokenIndex: _tokenIndex, ...annotation }) => annotation)
  };
}

export function fingerprintBase(chapters: Chapter[], annotations: Annotation[]) {
  let hash = 2166136261;
  const content = stableStringify(baseContent(chapters, annotations));
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `base-${(hash >>> 0).toString(36)}`;
}

function sentenceMap(chapters: Chapter[]) {
  return new Map(
    chapters.flatMap((chapter) =>
      chapter.sentences.map((sentence) => [sentence.id, { chapter, sentence }] as const)
    )
  );
}

function findTokenLocation(chapters: Chapter[], tokenId: string) {
  for (const chapter of chapters) {
    for (const sentence of chapter.sentences) {
      const index = sentence.tokens.findIndex((token) => token.id === tokenId);
      if (index >= 0) {
        return {
          chapter,
          sentence,
          token: sentence.tokens[index],
          index,
          text: sentence.tokens[index].text.trim()
        };
      }
    }
  }
  return undefined;
}

function findTokenInSentence(sentence: Sentence, tokenText: string, preferredIndex: number) {
  const meaningful = sentence.tokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.text.trim());

  const exact = meaningful.filter((item) => item.token.text.trim() === tokenText);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return exact.reduce((best, item) =>
      Math.abs(item.index - preferredIndex) < Math.abs(best.index - preferredIndex) ? item : best
    );
  }

  const joinMatches: typeof meaningful = [];
  for (let index = 0; index < meaningful.length; index += 1) {
    for (let end = index + 1; end <= meaningful.length; end += 1) {
      if (meaningful.slice(index, end).map((item) => item.token.text.trim()).join('') === tokenText) {
        joinMatches.push(meaningful[index]);
      }
    }
  }
  if (joinMatches.length === 1) return joinMatches[0];
  if (joinMatches.length > 1) {
    return joinMatches.reduce((best, item) =>
      Math.abs(item.index - preferredIndex) < Math.abs(best.index - preferredIndex) ? item : best
    );
  }

  const contained = meaningful.filter(
    (item) =>
      (item.token.text.includes(tokenText) || tokenText.includes(item.token.text)) &&
      item.token.text.trim().length > 1
  );
  if (contained.length === 1) return contained[0];
  return undefined;
}

export function ensureDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function createAnnotationId() {
  const device = ensureDeviceId().slice(0, 8);
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `annotation-${device}-${random}`;
}

export function normalizeDocument(document: TextDocument): TextDocument {
  const normalized = clone(document);
  const chapters = normalized.chapters ?? [];
  const annotations = normalized.annotations ?? [];

  for (const annotation of annotations) {
    annotation.references ??= [];
    annotation.tags ??= [];
    if (annotation.anchorType === 'word' && annotation.originTokenText === undefined) {
      const location = findTokenLocation(chapters, annotation.anchorId);
      if (location) {
        annotation.originSentenceId = location.sentence.id;
        annotation.originTokenText = location.text;
        annotation.originTokenIndex = location.index;
      }
    }
  }

  if (!normalized.bases?.length) {
    normalized.bases = [
      {
        id: 'base-initial',
        createdAt: normalized.updatedAt ?? new Date(0).toISOString(),
        chapters: clone(chapters),
        annotations: clone(annotations)
      }
    ];
  }
  normalized.baseId ??= normalized.bases[0]?.id ?? fingerprintBase(chapters, annotations);
  normalized.pendingDisputes ??= [];
  normalized.pendingAnchors ??= [];
  normalized.appliedPackageIds ??= [];
  normalized.snapshots ??= [];
  return normalized;
}

export function buildAnnotationPackage(document: TextDocument): AnnotationPackage {
  const normalized = normalizeDocument(document);
  const base = normalized.bases.find((item) => item.id === normalized.baseId) ?? normalized.bases[0];
  if (!base) throw new Error('缺少共同底本，无法导出批注包。');

  const currentAnnotationIds = new Set(normalized.annotations.map((item) => item.id));
  const currentSentenceIds = new Set(
    normalized.chapters.flatMap((chapter) => chapter.sentences.map((sentence) => sentence.id))
  );

  return {
    format: PACKAGE_FORMAT,
    packageId: `package-${ensureDeviceId().slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    deviceId: ensureDeviceId(),
    exportedAt: new Date().toISOString(),
    baseId: base.id,
    base: clone(base),
    chapters: clone(normalized.chapters),
    annotations: clone(normalized.annotations),
    deletedAnnotationIds: base.annotations.map((item) => item.id).filter((id) => !currentAnnotationIds.has(id)),
    deletedSentenceIds: base.chapters.flatMap((chapter) => chapter.sentences.map((sentence) => sentence.id)).filter((id) => !currentSentenceIds.has(id))
  };
}

function assertPackage(value: Partial<AnnotationPackage> | null | undefined): asserts value is AnnotationPackage {
  if (!value || value.format !== PACKAGE_FORMAT) {
    throw new Error('不是受支持的 v1 批注包。');
  }
  if (!value.packageId || !value.deviceId || !value.baseId) {
    throw new Error('批注包缺少设备、包号或底本标识。');
  }
  if (!value.base || !Array.isArray(value.base.chapters) || !Array.isArray(value.base.annotations)) {
    throw new Error('批注包缺少共同底本。');
  }
  if (!Array.isArray(value.chapters) || !Array.isArray(value.annotations)) {
    throw new Error('批注包正文或注释数据不完整。');
  }
}

export function parseAnnotationPackage(content: string): AnnotationPackage {
  try {
    const parsed = JSON.parse(content) as Partial<AnnotationPackage>;
    assertPackage(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('批注包 JSON 无法解析，本机草稿未改动。');
    throw error;
  }
}

function sameBase(left: MergeBaseSnapshot, chapters: Chapter[], annotations: Annotation[]) {
  return fingerprintBase(left.chapters, left.annotations) === fingerprintBase(chapters, annotations);
}

function threeWayArray(base: string[], local: string[], incoming: string[]) {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const incomingSet = new Set(incoming);
  const merged = new Set<string>();
  for (const item of new Set([...local, ...incoming])) {
    const existed = baseSet.has(item);
    const inLocal = localSet.has(item);
    const inIncoming = incomingSet.has(item);
    if (!existed && (inLocal || inIncoming)) merged.add(item);
    if (existed && (inLocal || inIncoming)) merged.add(item);
  }
  return Array.from(merged);
}

function changed(base: Annotation | undefined, value: Annotation) {
  if (!base) return true;
  return ['title', 'body', 'source'].some((field) => base[field as 'title'] !== value[field as 'title']);
}

function mergeAnnotationFields(
  base: Annotation,
  local: Annotation,
  incoming: Annotation,
  disputes: PendingDispute[],
  context: { packageId: string; deviceId: string; createdAt: string }
): Annotation {
  const merged = clone(local);
  const fieldDisputes: { field: MergeDispute['field']; baseValue: string; localValue: string; incomingValue: string }[] = [];

  for (const field of ['title', 'source'] as const) {
    const baseValue = base[field];
    const localValue = local[field];
    const incomingValue = incoming[field];
    if (localValue === incomingValue) {
      merged[field] = localValue;
    } else if (incomingValue !== baseValue && localValue === baseValue) {
      merged[field] = incomingValue;
    } else if (localValue !== baseValue && incomingValue === baseValue) {
      merged[field] = localValue;
    } else {
      merged[field] = localValue;
      fieldDisputes.push({ field, baseValue, localValue, incomingValue });
    }
  }

  const baseBody = base.body;
  const localBody = local.body;
  const incomingBody = incoming.body;
  if (localBody === incomingBody) {
    merged.body = localBody;
  } else if (incomingBody !== baseBody && localBody === baseBody) {
    merged.body = incomingBody;
  } else if (localBody !== baseBody && incomingBody === baseBody) {
    merged.body = localBody;
  } else {
    merged.body = localBody;
    // A body dispute must not silently absorb the other side's source or reference edits.
    merged.source = local.source;
    fieldDisputes.push({ field: 'body', baseValue: baseBody, localValue: localBody, incomingValue: incomingBody });
  }

  if (!fieldDisputes.some((item) => item.field === 'body')) {
    merged.tags = threeWayArray(base.tags, local.tags, incoming.tags);
    merged.references = threeWayArray(base.references, local.references, incoming.references);
  }
  merged.status = local.status === 'open' || incoming.status === 'open' ? 'open' : local.status;
  merged.conflictState = local.conflictState === 'open' || incoming.conflictState === 'open' ? 'open' : local.conflictState;
  merged.updatedAt = local.updatedAt > incoming.updatedAt ? local.updatedAt : incoming.updatedAt;

  for (const disputeFields of fieldDisputes) {
    disputes.push({
      id: `dispute-${merged.id}-${disputeFields.field}-${context.packageId}`,
      type: 'annotation',
      field: disputeFields.field,
      annotationId: merged.id,
      title: merged.title,
      kind: merged.kind,
      anchorId: merged.anchorId,
      anchorType: merged.anchorType,
      baseValue: disputeFields.baseValue,
      localValue: disputeFields.localValue,
      incomingValue: disputeFields.incomingValue,
      localSource: local.source,
      incomingSource: incoming.source,
      packageId: context.packageId,
      deviceId: context.deviceId,
      createdAt: context.createdAt,
      status: 'pending'
    });
  }

  return merged;
}

function reconcileDocumentAnchors(
  document: TextDocument,
  previousChapters: Chapter[],
  createdAt = new Date().toISOString()
) {
  const previousLocations = new Map(
    previousChapters.flatMap((chapter) =>
      chapter.sentences.flatMap((sentence) =>
        sentence.tokens
          .filter((token) => token.text.trim())
          .map((token) => [token.id, { sentenceId: sentence.id, text: token.text.trim(), index: sentence.tokens.indexOf(token) }] as const)
      )
    )
  );

  for (const annotation of document.annotations) {
    let sentenceId = annotation.originSentenceId;
    let tokenText = annotation.originTokenText;
    let tokenIndex = annotation.originTokenIndex;

    if ((!sentenceId || tokenText === undefined || tokenIndex === undefined) && annotation.anchorType === 'word') {
      const previous = previousLocations.get(annotation.anchorId);
      sentenceId ??= previous?.sentenceId;
      tokenText ??= previous?.text;
      tokenIndex ??= previous?.index;
    }
    if (!sentenceId || tokenText === undefined || tokenIndex === undefined) continue;

    const sentence = sentenceMap(document.chapters).get(sentenceId)?.sentence;
    if (!sentence) continue;
    const match = findTokenInSentence(sentence, tokenText, tokenIndex);

    if (match) {
      annotation.anchorType = 'word';
      annotation.anchorId = match.token.id;
      annotation.originSentenceId = sentence.id;
      annotation.originTokenText = match.token.text.trim();
      annotation.originTokenIndex = match.index;
      document.pendingAnchors = document.pendingAnchors.filter((item) => item.annotationId !== annotation.id);
      continue;
    }

    annotation.anchorType = 'sentence';
    annotation.anchorId = sentence.id;
    annotation.originSentenceId = sentence.id;
    annotation.originTokenText = tokenText;
    annotation.originTokenIndex = tokenIndex;
    const pendingId = `pending-anchor-${annotation.id}-${sentenceId}`;
    if (!document.pendingAnchors.some((item) => item.id === pendingId)) {
      document.pendingAnchors.push({
        id: pendingId,
        annotationId: annotation.id,
        sentenceId,
        tokenText,
        tokenIndex,
        reason: 'not-found',
        impact: `正文改动后未能在实际文本中定位词语“${tokenText}”，注释暂挂到所属句；确认前来源和引用均未改动。`,
        createdAt,
        status: 'pending'
      });
    }
  }
}

export { reconcileDocumentAnchors };

interface TextMergeContext {
  merged: TextDocument;
  baseMap: ReturnType<typeof sentenceMap>;
  localMap: ReturnType<typeof sentenceMap>;
  incomingMap: ReturnType<typeof sentenceMap>;
  disputes: PendingDispute[];
  issues: MergeIssue[];
  packageId: string;
  deviceId: string;
  createdAt: string;
}

function mergeSentenceTexts(context: TextMergeContext) {
  const { merged, baseMap, localMap, incomingMap, disputes, issues, packageId, deviceId, createdAt } = context;
  for (const [sentenceId, baseEntry] of baseMap) {
    const localEntry = localMap.get(sentenceId);
    const incomingEntry = incomingMap.get(sentenceId);
    if (!localEntry?.sentence || !incomingEntry?.sentence) {
      throw new Error(`底本句子 ${sentenceId} 在其中一侧缺失，暂不能安全合并。`);
    }

    const baseText = baseEntry.sentence.text;
    const localText = localEntry.sentence.text;
    const incomingText = incomingEntry.sentence.text;
    const targetMergedSentence = merged.chapters
      .flatMap((chapter) => chapter.sentences)
      .find((sentence) => sentence.id === sentenceId);
    if (!targetMergedSentence) throw new Error(`合并结果缺少句子 ${sentenceId}。`);

    let nextText = localText;
    let nextTokens = localEntry.sentence.tokens;
    if (localText === incomingText) {
      nextText = localText;
      nextTokens = localEntry.sentence.tokens;
    } else if (localText !== baseText && incomingText === baseText) {
      nextText = localText;
      nextTokens = localEntry.sentence.tokens;
    } else if (incomingText !== baseText && localText === baseText) {
      nextText = incomingText;
      nextTokens = tokenizeText(incomingText, sentenceId, baseEntry.sentence.tokens);
      issues.push({ kind: 'text', message: `${baseEntry.chapter.title} · 第 ${baseEntry.sentence.order} 句已并入对方正文改动。` });
    } else {
      nextText = localText;
      nextTokens = localEntry.sentence.tokens;
      disputes.push({
        id: `dispute-text-${sentenceId}-${packageId}`,
        type: 'text',
        sentenceId,
        chapterId: baseEntry.chapter.id,
        label: `${baseEntry.chapter.title} · 第 ${baseEntry.sentence.order} 句正文争议`,
        localText,
        incomingText,
        baseText,
        baseTokens: clone(baseEntry.sentence.tokens),
        packageId,
        deviceId,
        createdAt,
        status: 'pending'
      });
      issues.push({ kind: 'dispute', message: `${baseEntry.chapter.title} · 第 ${baseEntry.sentence.order} 句两边均改正文，已保留本机值并列待决。` });
    }

    if (nextText !== baseText || localEntry.sentence.tokens !== nextTokens) {
      targetMergedSentence.text = nextText;
      targetMergedSentence.tokens = clone(nextTokens);
    }
  }
}

export function mergeAnnotationPackage(currentDocument: TextDocument, imported: AnnotationPackage): MergeResult {
  assertPackage(imported);
  const document = normalizeDocument(currentDocument);
  if (document.appliedPackageIds.includes(imported.packageId)) {
    return { document: currentDocument, applied: false, duplicate: true, issues: [] };
  }

  const commonBase = document.bases.find((base) => base.id === imported.base.id && sameBase(base, imported.base.chapters, imported.base.annotations))
    ?? document.bases.find((base) => sameBase(base, imported.base.chapters, imported.base.annotations));
  if (!commonBase) {
    throw new Error('批注包底本不在本机底本谱系中；无法确认共同底本，本机草稿保留未动。');
  }
  if (imported.deviceId === ensureDeviceId() && fingerprintBase(imported.chapters, imported.annotations) === fingerprintBase(document.chapters, document.annotations)) {
    return { document: currentDocument, applied: false, duplicate: true, issues: [] };
  }

  const merged = normalizeDocument(document);
  const createdAt = new Date().toISOString();
  const issues: MergeIssue[] = [];
  const disputes = clone(merged.pendingDisputes);
  merged.pendingAnchors = clone(merged.pendingAnchors);

  const baseMap = sentenceMap(commonBase.chapters);
  const localMap = sentenceMap(document.chapters);
  const incomingMap = sentenceMap(imported.chapters);
  for (const sentenceId of imported.deletedSentenceIds ?? []) {
    if (commonBase.chapters.some((chapter) => chapter.sentences.some((sentence) => sentence.id === sentenceId))) {
      throw new Error('批注包包含句子删除；当前合并器不支持句子结构删除，本机草稿保留未动。');
    }
  }
  mergeSentenceTexts({ merged, baseMap, localMap, incomingMap, disputes, issues, packageId: imported.packageId, deviceId: imported.deviceId, createdAt });

  const baseAnnotations = new Map(commonBase.annotations.map((item) => [item.id, item]));
  const localAnnotations = new Map(document.annotations.map((item) => [item.id, item]));
  const incomingAnnotations = new Map(imported.annotations.map((item) => [item.id, item]));
  const resultAnnotations: Annotation[] = [];
  const uncontestedDeletions = new Set<string>();
  const context = { packageId: imported.packageId, deviceId: imported.deviceId, createdAt };

  for (const [id, baseAnnotation] of baseAnnotations) {
    const local = localAnnotations.get(id);
    const incoming = incomingAnnotations.get(id);

    if (!local && !incoming) {
      uncontestedDeletions.add(id);
      continue;
    }
    if (!local) {
      if (incoming && changed(baseAnnotation, incoming)) {
        resultAnnotations.push(clone(incoming));
        disputes.push({
          id: `dispute-delete-${id}-${imported.packageId}`,
          type: 'deletion',
          annotationId: id,
          annotation: clone(incoming),
          ...context,
          status: 'pending'
        });
        issues.push({ kind: 'dispute', message: `“${incoming.title}”本机已删、对方有新改动，暂保留并列待决。` });
      } else {
        uncontestedDeletions.add(id);
      }
      continue;
    }
    if (!incoming) {
      if (local && changed(baseAnnotation, local)) {
        resultAnnotations.push(clone(local));
        disputes.push({
          id: `dispute-delete-${id}-${imported.packageId}`,
          type: 'deletion',
          annotationId: id,
          annotation: clone(local),
          ...context,
          status: 'pending'
        });
        issues.push({ kind: 'dispute', message: `“${local.title}”对方已删、本机有新改动，暂保留并列待决。` });
      } else {
        uncontestedDeletions.add(id);
      }
      continue;
    }

    const localChanged = changed(baseAnnotation, local);
    const incomingChanged = changed(baseAnnotation, incoming);
    if (!localChanged && !incomingChanged) {
      resultAnnotations.push(clone(local));
    } else if (localChanged && !incomingChanged) {
      resultAnnotations.push(clone(local));
    } else if (!localChanged && incomingChanged) {
      resultAnnotations.push(clone(incoming));
      issues.push({ kind: 'changed-annotation', message: `已并入对方注释改动：${incoming.title}` });
    } else if (local.body === incoming.body && local.source === incoming.source && local.title === incoming.title) {
      resultAnnotations.push(clone(local));
    } else {
      const before = disputes.length;
      const combined = mergeAnnotationFields(baseAnnotation, local, incoming, disputes, context);
      resultAnnotations.push(combined);
      if (disputes.length > before) {
        issues.push({ kind: 'dispute', message: `注释“${combined.title}”存在两边新值，确认前保留本机来源与引用。` });
      } else {
        issues.push({ kind: 'changed-annotation', message: `已互补合并注释：${combined.title}` });
      }
    }
  }

  for (const [id, annotation] of localAnnotations) {
    if (baseAnnotations.has(id)) continue;
    resultAnnotations.push(clone(annotation));
  }
  for (const [id, annotation] of incomingAnnotations) {
    if (baseAnnotations.has(id) || localAnnotations.has(id)) continue;
    resultAnnotations.push(clone(annotation));
    issues.push({ kind: 'added-annotation', message: `已新增对方注释：${annotation.title}` });
  }

  if (uncontestedDeletions.size) {
    for (const annotation of resultAnnotations) {
      annotation.references = annotation.references.filter((id) => !uncontestedDeletions.has(id));
    }
    for (const id of uncontestedDeletions) {
      const base = baseAnnotations.get(id);
      if (base) issues.push({ kind: 'deleted-annotation', message: `双方一致删除注释：${base.title}` });
    }
  }

  merged.annotations = resultAnnotations;
  merged.pendingDisputes = disputes.filter((dispute, index, list) => {
    const firstIndex = list.findIndex((item) => item.id === dispute.id);
    return firstIndex === index;
  });
  reconcileDocumentAnchors(merged, document.chapters, createdAt);
  for (const pending of merged.pendingAnchors) {
    if (!document.pendingAnchors.some((item) => item.id === pending.id)) {
      issues.push({ kind: 'pending-anchor', message: pending.impact });
    }
  }

  // Keep the agreed common base while decisions are open so the next offline package
  // can use the same three-way parent. The merge result itself is available through
  // current draft, snapshots, exports, and version comparison.
  merged.baseId = commonBase.id;
  if (merged.bases.length > 20) merged.bases = merged.bases.slice(-20);
  merged.appliedPackageIds = Array.from(new Set([...merged.appliedPackageIds, imported.packageId]));
  merged.updatedAt = createdAt;

  return { document: merged, applied: true, duplicate: false, issues };
}

function updateBaseIfStable(document: TextDocument, createdAt: string) {
  if (document.pendingDisputes.length || document.pendingAnchors.length) return;
  const id = fingerprintBase(document.chapters, document.annotations);
  document.baseId = id;
  if (!document.bases.some((base) => sameBase(base, document.chapters, document.annotations))) {
    document.bases.push({
      id,
      createdAt,
      chapters: clone(document.chapters),
      annotations: clone(document.annotations)
    });
  }
  if (document.bases.length > 20) document.bases = document.bases.slice(-20);
}

export function resolvePendingDispute(
  document: TextDocument,
  disputeId: string,
  choice: 'local' | 'incoming' | 'combine' | 'delete' | 'keep'
) {
  const dispute = document.pendingDisputes.find((item) => item.id === disputeId);
  if (!dispute) return;
  const createdAt = new Date().toISOString();

  if (dispute.type === 'annotation') {
    const annotation = document.annotations.find((item) => item.id === dispute.annotationId);
    if (!annotation) {
      document.pendingDisputes = document.pendingDisputes.filter((item) => item.id !== disputeId);
      return;
    }
    if (choice === 'local' || choice === 'keep') {
      annotation[dispute.field] = dispute.localValue;
    } else if (choice === 'incoming') {
      annotation[dispute.field] = dispute.incomingValue;
    } else if (choice === 'combine') {
      annotation[dispute.field] = dispute.field === 'title'
        ? `${dispute.localValue}｜${dispute.incomingValue}`
        : `【${dispute.localSource}】${dispute.localValue}\n\n【${dispute.incomingSource}】${dispute.incomingValue}`;
    }
    annotation.updatedAt = createdAt;
  }

  if (dispute.type === 'deletion') {
    if (choice === 'delete') {
      document.annotations = document.annotations.filter((item) => item.id !== dispute.annotationId);
      for (const annotation of document.annotations) {
        annotation.references = annotation.references.filter((id) => id !== dispute.annotationId);
      }
    }
  }

  if (dispute.type === 'text' && (choice === 'local' || choice === 'incoming')) {
    const text = choice === 'local' ? dispute.localText : dispute.incomingText;
    const sentence = sentenceMap(document.chapters).get(dispute.sentenceId)?.sentence;
    if (sentence) {
      sentence.text = text;
      sentence.tokens = tokenizeText(text, sentence.id, choice === 'local' ? sentence.tokens : dispute.baseTokens);
      reconcileDocumentAnchors(document, document.chapters);
    }
  }

  document.pendingDisputes = document.pendingDisputes.filter((item) => item.id !== disputeId);
  document.updatedAt = createdAt;
  updateBaseIfStable(document, createdAt);
}

export function confirmPendingAnchor(document: TextDocument, pendingId: string, acknowledge: boolean) {
  const pending = document.pendingAnchors.find((item) => item.id === pendingId);
  if (!pending) return;
  const createdAt = new Date().toISOString();
  reconcileDocumentAnchors(document, document.chapters, createdAt);
  const stillPending = document.pendingAnchors.some((item) => item.id === pendingId);
  if (stillPending && !acknowledge) return;
  document.pendingAnchors = document.pendingAnchors.filter((item) => item.id !== pendingId);
  document.updatedAt = createdAt;
  updateBaseIfStable(document, createdAt);
}

export type { PendingAnchor };
