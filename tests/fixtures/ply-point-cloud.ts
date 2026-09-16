/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic ASCII point-cloud .ply generator for the import specs. Generated in the test rather than checked in: a fixture large enough that the conversion takes measurable time (hundreds of thousands of vertices, several MB) has no business in git, and a generator lets each spec size it to the assertion it makes (a conversion long enough to sample the event loop against; one that must overrun a small worker heap).
 */

/** The vertex properties every generated cloud carries (float xyz + uchar rgb, ~22 bytes per ASCII line). */
const HEADER = [
  'ply', 'format ascii 1.0',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'end_header',
];

/**
 * @description Build an ASCII point-cloud PLY with `vertexCount` coloured vertices. The values
 * cycle through small prime moduli so the cloud has a non-degenerate bounding box and every
 * vertex parses as finite numbers; the same count always produces the same bytes.
 * @param vertexCount - How many vertices to emit
 * @returns The PLY text (LF line endings)
 */
export function asciiPointCloudPly(vertexCount: number): string {
  const lines: string[] = [HEADER[0], HEADER[1], `element vertex ${vertexCount}`, ...HEADER.slice(2)];
  for (let i = 0; i < vertexCount; i++) {
    lines.push(`${(i % 97) / 10} ${(i % 89) / 10} ${(i % 83) / 10} ${i % 256} ${(i * 7) % 256} ${(i * 13) % 256}`);
  }
  return `${lines.join('\n')}\n`;
}
