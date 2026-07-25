import * as fs from 'fs';
import * as path from 'path';
import { countsMatch, parseAideReport, toNodePath } from './aide-parser';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

/**
 * Captured verbatim from a lab cluster running File Integrity Operator 1.4.0,
 * whose daemon image ships AIDE 0.16. Regenerate with:
 *   oc get cm <resultConfigMapName> -n openshift-file-integrity \
 *     -o jsonpath='{.data.integritylog}'
 */
const report016 = fixture('aide-0.16-report.txt');

/**
 * Hand-written, NOT captured: the operator's current image does not ship AIDE
 * 0.18, so this encodes the 0.18-shaped variations we must tolerate (comma
 * separators, `Directory:` blocks, wrapped values) rather than real output.
 */
const report018 = fixture('aide-0.18-report.txt');

describe('toNodePath', () => {
  it('strips the AIDE bind-mount prefix', () => {
    expect(toNodePath('/hostroot/etc/passwd')).toBe('/etc/passwd');
    expect(toNodePath('/hostroot')).toBe('/');
  });

  it('leaves unprefixed paths alone', () => {
    expect(toNodePath('/etc/passwd')).toBe('/etc/passwd');
    // Must not truncate a directory that merely starts with the same letters.
    expect(toNodePath('/hostrootlike/x')).toBe('/hostrootlike/x');
  });
});

describe('parseAideReport - AIDE 0.16 (real capture)', () => {
  const report = parseAideReport(report016);

  it('reads the header', () => {
    expect(report.aideVersion).toBe('0.16');
    expect(report.startTime).toBe('2026-07-25 12:46:41 +0000');
    expect(report.parseFailed).toBe(false);
    expect(report.truncated).toBe(false);
  });

  it('reads the summary', () => {
    expect(report.summary).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      totalEntries: 40932,
    });
  });

  it('finds one entry of each kind, with node-relative paths', () => {
    expect(report.entries.map((e) => [e.kind, e.path])).toEqual([
      ['added', '/etc/fio-demo-added.conf'],
      ['removed', '/etc/fio-demo-removed.conf'],
      ['changed', '/etc/fio-demo-changed.conf'],
    ]);
  });

  it('agrees with the operator-recorded counts', () => {
    expect(countsMatch(report, { added: 1, changed: 1, removed: 1 })).toBe(
      true,
    );
  });

  it('parses the permission change', () => {
    const changed = report.entries.find((e) => e.kind === 'changed')!;
    expect(changed.attrs).toContainEqual({
      name: 'Perm',
      old: '-rw-r--r--',
      new: '-rw-------',
    });
  });

  it('rejoins a hash wrapped across three lines', () => {
    const changed = report.entries.find((e) => e.kind === 'changed')!;
    const sha = changed.attrs.find((a) => a.name === 'SHA512')!;
    expect(sha.old).toBe(
      'sqW/zvjlIR/0Zf4REiiANHHp5AFNgil+OYKwTbP9B8x1MqU8dDmVcvL37NK95Ar4dks9oSoqFDZYsFgGQp2x6w==',
    );
    expect(sha.new).toBe(
      'OEt8EddDVc1gTM/B8/niWSswRfkvo0VXszBAM/ihMVFUXl01yjYslPMnRji8VG4IFvfRJQIcFVGOgpixBEEylA==',
    );
  });

  it('keeps a genuinely multi-line ACL readable instead of gluing it', () => {
    const changed = report.entries.find((e) => e.kind === 'changed')!;
    const acl = changed.attrs.find((a) => a.name === 'ACL')!;
    expect(acl.old).toBe('A: user::rw-\nA: group::r--\nA: other::r--');
    expect(acl.new).toBe('A: user::rw-\nA: group::---\nA: other::---');
  });

  it('does not invent an attribute from an ACL continuation line', () => {
    const changed = report.entries.find((e) => e.kind === 'changed')!;
    expect(changed.attrs.map((a) => a.name)).toEqual(['Perm', 'SHA512', 'ACL']);
  });

  it('does not attribute the trailing database section to the last entry', () => {
    // "The attributes of the (uncompressed) database(s)" is formatted exactly
    // like a detail block; its MD5/SHA1/RMD160/TIGER must not leak in.
    const names = report.entries.flatMap((e) => e.attrs.map((a) => a.name));
    expect(names).not.toContain('RMD160');
    expect(names).not.toContain('TIGER');
    expect(names).not.toContain('SHA1');
    expect(report.entries).toHaveLength(3);
  });
});

describe('parseAideReport - AIDE 0.18 shape', () => {
  const report = parseAideReport(report018);

  it('reads the header and summary', () => {
    expect(report.aideVersion).toBe('0.18');
    expect(report.summary).toEqual({
      added: 2,
      changed: 2,
      removed: 1,
      totalEntries: 41221,
    });
    expect(report.parseFailed).toBe(false);
  });

  it('collects every entry across all three sections', () => {
    expect(report.entries.map((e) => [e.kind, e.path])).toEqual([
      ['added', '/etc/cron.d/rogue'],
      ['added', '/opt/staging'],
      ['removed', '/etc/motd.d/welcome'],
      ['changed', '/etc/sysctl.conf'],
      ['changed', '/etc/pki/tls'],
    ]);
    expect(countsMatch(report, { added: 2, changed: 2, removed: 1 })).toBe(
      true,
    );
  });

  it('accepts comma-separated attribute values', () => {
    const sysctl = report.entries.find((e) => e.path === '/etc/sysctl.conf')!;
    expect(sysctl.attrs).toContainEqual({
      name: 'Size',
      old: '449',
      new: '512',
    });
    const sha = sysctl.attrs.find((a) => a.name === 'SHA512')!;
    expect(sha.old).toBe(
      'Bq1RZTQ0dGhpc2lzYXRlc3RoYXNodmFsdWV0aGF0d3JhcHNhY3Jvc3NsaW5lcw==',
    );
    expect(sha.new).toBe(
      'WGZ2YWx1ZXRoYXRkaWZmZXJzZnJvbXRoZW9yaWdpbmFsb25lYW5kd3JhcHM=',
    );
  });

  it('handles a Directory: detail block', () => {
    const tls = report.entries.find((e) => e.path === '/etc/pki/tls')!;
    expect(tls.fileType).toBe('d');
    expect(tls.attrs.map((a) => a.name)).toEqual(['Mtime', 'Ctime']);
  });
});

describe('parseAideReport - degenerate input', () => {
  it('flags an empty report as unparsable', () => {
    expect(parseAideReport('').parseFailed).toBe(true);
    expect(parseAideReport('   \n  ').parseFailed).toBe(true);
  });

  it('detects the operator "too large" placeholder', () => {
    const placeholder =
      'compressed AIDE log is too large for a configMap (2097152) - fetch it from /etc/kubernetes/aide.log on node worker-0';
    const report = parseAideReport(placeholder);
    expect(report.truncated).toBe(true);
    expect(report.parseFailed).toBe(false);
    expect(report.entries).toHaveLength(0);
  });

  it('does not flag a clean report as unparsable', () => {
    const clean = [
      'Start timestamp: 2026-07-25 12:44:05 +0000 (AIDE 0.16)',
      'AIDE found NO differences between database and filesystem. Looks okay!!',
      '',
      'Number of entries:\t40932',
      '',
    ].join('\n');
    const report = parseAideReport(clean);
    expect(report.parseFailed).toBe(false);
    expect(report.entries).toHaveLength(0);
    expect(report.summary).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it('reports a parse failure when changes are announced but none are found', () => {
    const unknown = [
      'AIDE found differences between database and filesystem!!',
      '',
      'Summary:',
      '  Total number of entries:\t10',
      '  Added entries:\t\t3',
      '  Removed entries:\t\t0',
      '  Changed entries:\t\t0',
      '',
      '<<< some future format we do not understand >>>',
    ].join('\n');
    const report = parseAideReport(unknown);
    expect(report.parseFailed).toBe(true);
    expect(report.summary.added).toBe(3);
  });

  it('surfaces a count mismatch', () => {
    const report = parseAideReport(report016);
    expect(countsMatch(report, { added: 5 })).toBe(false);
  });
});
