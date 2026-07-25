import { TRUNCATED_MARKERS } from '../constants';
import {
  AideAttrChange,
  AideEntry,
  AideEntryKind,
  AideReport,
  AideSummary,
} from '../types';

/**
 * Parser for the plain-text AIDE report that the File Integrity Operator stores
 * in its result ConfigMaps.
 *
 * Two grammars are in the wild and both must work:
 *   - AIDE 0.16 (`CONTENTEX` config keyword), shipped by the operator's current
 *     base image;
 *   - AIDE 0.18+ (`CONTENT_EX`), used by newer builds.
 * They differ in the attribute separator (`|` or `,`) and in which entry types
 * open a detail block, so we accept both rather than branching on the version
 * string — a cluster mid-upgrade can serve either.
 *
 * The parser is deliberately forgiving: anything it cannot make sense of leaves
 * `parseFailed` set so the UI can fall back to showing the raw text. It must
 * never throw on unexpected input.
 */

/** Paths inside the report are relative to the AIDE bind mount, not the node. */
const HOSTROOT_PREFIX = '/hostroot';

/** Strips the AIDE bind-mount prefix to give the real path on the node. */
export const toNodePath = (reportPath: string): string => {
  if (reportPath === HOSTROOT_PREFIX) {
    return '/';
  }
  if (reportPath.startsWith(`${HOSTROOT_PREFIX}/`)) {
    return reportPath.slice(HOSTROOT_PREFIX.length);
  }
  return reportPath;
};

const SUMMARY_PATTERNS = {
  totalEntries: /Total number of entries:\s+(\d+)/,
  added: /Added entries:\s+(\d+)/,
  removed: /Removed entries:\s+(\d+)/,
  changed: /Changed entries:\s+(\d+)/,
} as const;

type Section = AideEntryKind | 'detailed' | 'none';

const SECTION_HEADINGS: Array<{ re: RegExp; section: Section }> = [
  { re: /^Added (?:entries|files):?$/i, section: 'added' },
  { re: /^Removed (?:entries|files):?$/i, section: 'removed' },
  { re: /^Changed (?:entries|files):?$/i, section: 'changed' },
  { re: /^Detailed information about changes:?$/i, section: 'detailed' },
];

/** A rule line such as `---------------------------------`. */
const isRuleLine = (line: string) => /^-{3,}$/.test(line.trim());

/**
 * Entry line inside an Added/Removed/Changed section, e.g.
 *   `f++++++++++++++++: /hostroot/etc/fio-demo-added.conf`
 *   `f   p..    .CA.. : /hostroot/etc/fio-demo-changed.conf`
 * The flags field never contains a slash, so anchoring the path to the first
 * `: /` is unambiguous even for paths that themselves contain a colon.
 */
const ENTRY_LINE = /^(?<flags>\S[^/]*?)\s*:\s*(?<path>\/.*)$/;

/** Head of a detail block, e.g. `File: /hostroot/etc/resolv.conf`. */
const DETAIL_HEAD = /^(?<type>[A-Za-z]+):\s+(?<path>\/.*)$/;

/**
 * Attribute line inside a detail block, e.g. `  Perm     : -rw-r--r-- | -rw----`.
 *
 * AIDE indents attribute names by two spaces and wraps long values onto lines
 * indented to the value column (thirteen spaces). Anchoring on a *shallow*
 * indent is what keeps an ACL continuation such as `   A: group::r--` from
 * being mistaken for an attribute named "A".
 */
const ATTR_LINE = /^ {1,4}(?<name>[A-Za-z][A-Za-z0-9_ -]*?)\s*:\s(?<rest>.*)$/;

/** Continuation lines are indented past the attribute-name column. */
const CONTINUATION_LINE = /^ {5,}(?<rest>\S.*)$/;

type SplitValues = { old: string; next?: string };

/**
 * Splits an attribute's value text into old and new halves.
 *
 * AIDE right-pads the old value and separates with `|` (0.16 and 0.18) or `,`
 * (some 0.16 builds). Values can themselves contain the separator — an ACL
 * reads `A: user::rw-` and a link target can contain a comma — so we require
 * the separator to be preceded by two or more spaces, which is how AIDE's
 * column padding always renders it, and only fall back to a looser match when
 * no padded separator exists.
 */
const splitAttrValues = (rest: string): SplitValues => {
  const padded = /^(?<old>.*?)\s{2,}[|,]\s*(?<next>.*)$/.exec(rest);
  if (padded?.groups) {
    return {
      old: padded.groups.old.trim(),
      next: padded.groups.next.trim(),
    };
  }
  const loose = /^(?<old>.*?)\s+[|,]\s+(?<next>.*)$/.exec(rest);
  if (loose?.groups) {
    return { old: loose.groups.old.trim(), next: loose.groups.next.trim() };
  }
  return { old: rest.trim() };
};

/**
 * Rejoins the chunks AIDE split across lines.
 *
 * Hashes are wrapped purely for display, so gluing their chunks back together
 * restores the real value. Anything containing a space (an ACL, a link target)
 * was genuinely multi-line, so those keep their newlines.
 */
const joinChunks = (chunks: string[]): string => {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const looksWrapped = chunks.every((c) => /^[A-Za-z0-9+/=]+$/.test(c));
  return chunks.join(looksWrapped ? '' : '\n');
};

const emptySummary = (): AideSummary => ({ added: 0, changed: 0, removed: 0 });

const parseSummary = (text: string): AideSummary => {
  const summary = emptySummary();
  const total = SUMMARY_PATTERNS.totalEntries.exec(text);
  if (total) {
    summary.totalEntries = Number.parseInt(total[1], 10);
  }
  (['added', 'removed', 'changed'] as const).forEach((key) => {
    const m = SUMMARY_PATTERNS[key].exec(text);
    if (m) {
      summary[key] = Number.parseInt(m[1], 10);
    }
  });
  return summary;
};

/**
 * True when the operator replaced the report with its "too large" sentence
 * instead of the actual AIDE output.
 */
export const isTruncatedReport = (text: string): boolean =>
  TRUNCATED_MARKERS.some((marker) => text.includes(marker));

export const parseAideReport = (raw: string): AideReport => {
  const report: AideReport = {
    summary: emptySummary(),
    entries: [],
    truncated: false,
    parseFailed: false,
    raw,
  };

  if (!raw || !raw.trim()) {
    report.parseFailed = true;
    return report;
  }

  if (isTruncatedReport(raw)) {
    report.truncated = true;
    return report;
  }

  try {
    return parseUnsafe(raw, report);
  } catch {
    // A malformed report must degrade to the raw view, never break the page.
    return { ...report, entries: [], parseFailed: true };
  }
};

/** Accumulates the wrapped chunks of one attribute before they are joined. */
type PendingAttr = {
  change: AideAttrChange;
  oldChunks: string[];
  newChunks: string[];
  /** Whether the opening line had a separator at all. */
  split: boolean;
};

const parseUnsafe = (raw: string, report: AideReport): AideReport => {
  const lines = raw.split('\n');

  const version = /\(AIDE\s+([\d.]+)\)|^AIDE\s+([\d.]+)\s+found differences/m.exec(
    raw,
  );
  if (version) {
    report.aideVersion = version[1] ?? version[2];
  }
  const start = /^Start timestamp:\s*(.+?)(?:\s*\(AIDE.*\))?\s*$/m.exec(raw);
  if (start) {
    report.startTime = start[1].trim();
  }

  report.summary = parseSummary(raw);

  const byPath = new Map<string, AideEntry>();
  const ordered: AideEntry[] = [];

  let section: Section = 'none';
  let detailTarget: AideEntry | undefined;
  let pending: PendingAttr | undefined;
  /** Section headings are the line that follows a `-----` rule. */
  let prevWasRule = false;

  const upsert = (reportPath: string, kind: AideEntryKind): AideEntry => {
    const existing = byPath.get(reportPath);
    if (existing) {
      return existing;
    }
    const entry: AideEntry = {
      path: toNodePath(reportPath),
      kind,
      attrs: [],
    };
    byPath.set(reportPath, entry);
    ordered.push(entry);
    return entry;
  };

  const flushPending = () => {
    if (!pending) {
      return;
    }
    pending.change.old = joinChunks(pending.oldChunks);
    pending.change.new = pending.split
      ? joinChunks(pending.newChunks)
      : undefined;
    pending = undefined;
  };

  for (const line of lines) {
    if (isRuleLine(line)) {
      flushPending();
      prevWasRule = true;
      continue;
    }

    // The line right after a rule is a section heading. Anything we do not
    // recognise — notably "The attributes of the (uncompressed) database(s):",
    // which is formatted exactly like a detail block — closes the current
    // section so its contents cannot be attributed to the previous entry.
    if (prevWasRule) {
      prevWasRule = false;
      if (line.trim()) {
        flushPending();
        detailTarget = undefined;
        const trimmed = line.trim();
        section =
          SECTION_HEADINGS.find(({ re }) => re.test(trimmed))?.section ?? 'none';
        continue;
      }
    }

    if (!line.trim()) {
      flushPending();
      continue;
    }

    if (section === 'added' || section === 'removed' || section === 'changed') {
      const m = ENTRY_LINE.exec(line);
      if (m?.groups) {
        const entry = upsert(m.groups.path.trim(), section);
        entry.changeFlags = m.groups.flags.trim();
        entry.fileType = m.groups.flags.trim().charAt(0);
      }
      continue;
    }

    if (section !== 'detailed') {
      continue;
    }

    // An unindented `File: /path` line opens a new detail block.
    if (!/^\s/.test(line)) {
      flushPending();
      const head = DETAIL_HEAD.exec(line);
      if (head?.groups) {
        // Detail blocks only ever describe changed entries; if the section
        // pass never saw this path, record it rather than drop it.
        detailTarget = upsert(head.groups.path.trim(), 'changed');
        if (!detailTarget.fileType) {
          detailTarget.fileType = head.groups.type.charAt(0).toLowerCase();
        }
      } else {
        detailTarget = undefined;
      }
      continue;
    }

    if (!detailTarget) {
      continue;
    }

    const continuation = CONTINUATION_LINE.exec(line);
    if (continuation?.groups && pending) {
      const { old, next } = splitAttrValues(continuation.groups.rest);
      pending.oldChunks.push(old);
      if (next !== undefined) {
        pending.newChunks.push(next);
      }
      continue;
    }

    const attr = ATTR_LINE.exec(line);
    if (attr?.groups) {
      flushPending();
      const { old, next } = splitAttrValues(attr.groups.rest);
      const change: AideAttrChange = { name: attr.groups.name.trim() };
      detailTarget.attrs.push(change);
      pending = {
        change,
        oldChunks: [old],
        newChunks: next === undefined ? [] : [next],
        split: next !== undefined,
      };
    }
  }
  flushPending();

  report.entries = ordered;

  // A report that announced changes but yielded nothing parsable means our
  // grammar did not match this AIDE build; say so instead of rendering an
  // empty table that looks like "nothing happened".
  const announced =
    report.summary.added + report.summary.changed + report.summary.removed;
  if (announced > 0 && ordered.length === 0) {
    report.parseFailed = true;
  }

  return report;
};

/**
 * Compares what we parsed against the counts the operator recorded in the
 * ConfigMap annotations. A mismatch means the report contains entries our
 * grammar skipped, which the UI should warn about rather than hide.
 */
export const countsMatch = (
  report: AideReport,
  expected: { added?: number; changed?: number; removed?: number },
): boolean => {
  const actual: Record<AideEntryKind, number> = {
    added: 0,
    changed: 0,
    removed: 0,
  };
  report.entries.forEach((e) => {
    actual[e.kind] += 1;
  });
  return (['added', 'changed', 'removed'] as const).every(
    (kind) => expected[kind] === undefined || expected[kind] === actual[kind],
  );
};
