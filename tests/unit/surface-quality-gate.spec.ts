import { describe, expect, it } from 'vitest';
import { evaluateSurfaceQuality, summarizeSurfaceQuality } from '../../scripts/quality/surface-quality-gate';

const GOOD_PAGE = `<!doctype html><html><head>
  <link rel="stylesheet" href="/shared/ui/css/surface-glass.css">
</head><body>
  <h1>Connectors</h1>
  <main><p>Manage your connected accounts. Nothing connected yet.</p><button>Connect</button></main>
</body></html>`;

describe('evaluateSurfaceQuality', () => {
  it('passes a well-formed, shared-styled surface with no console errors', () => {
    const r = evaluateSurfaceQuality({ url: '/connectors', html: GOOD_PAGE, status: 200, consoleErrors: [] });
    expect(r.passed).toBe(true);
    expect(r.findings.filter((f) => f.severity === 'fail')).toHaveLength(0);
  });

  it('fails a raw JSON envelope shown to the user', () => {
    const r = evaluateSurfaceQuality({ url: '/api-leak', html: '{"success":false,"error":"boom","data":null}', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('raw-json-envelope');
  });

  it('fails a leaked error/stack trace', () => {
    const html = `${GOOD_PAGE.replace('</main>', '')}<pre>TypeError: Cannot read properties of undefined (reading 'x')\n    at render (app.js:42:11)</pre></main></body></html>`;
    const r = evaluateSurfaceQuality({ url: '/broken', html, status: 200 });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('error-stack');
  });

  it('fails on console errors even when the page renders', () => {
    const r = evaluateSurfaceQuality({ url: '/noisy', html: GOOD_PAGE, status: 200, consoleErrors: ["Uncaught ReferenceError: foo is not defined"] });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('console-errors');
  });

  it('fails an HTTP error status', () => {
    const r = evaluateSurfaceQuality({ url: '/oops', html: GOOD_PAGE, status: 500 });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('http-error');
  });

  it('fails an unstyled surface (broken CSS / MIME failure)', () => {
    const r = evaluateSurfaceQuality({ url: '/plain', html: '<html><body><div>some real content here without any styling at all</div></body></html>', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('unstyled');
  });

  it('fails a blank/empty surface', () => {
    const r = evaluateSurfaceQuality({ url: '/blank', html: '<html><head><style>body{}</style></head><body></body></html>', status: 200 });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain('blank-surface');
  });

  it('warns (does not fail) when a styled surface skips the shared theme', () => {
    const html = '<html><head><link rel="stylesheet" href="/vendor/only.css"></head><body><h1>App</h1><p>real content lives here for the reader</p></body></html>';
    const r = evaluateSurfaceQuality({ url: '/offtheme', html, status: 200 });
    expect(r.passed).toBe(true);
    expect(r.findings.map((f) => f.rule)).toContain('missing-shared-css');
  });
});

describe('summarizeSurfaceQuality', () => {
  it('rolls up pass/fail/warn counts and lists failing urls', () => {
    const results = [
      evaluateSurfaceQuality({ url: '/ok', html: GOOD_PAGE, status: 200 }),
      evaluateSurfaceQuality({ url: '/bad', html: '{"success":true}', status: 200 }),
      evaluateSurfaceQuality({ url: '/warn', html: '<html><head><link rel="stylesheet" href="/x.css"></head><body><p>content for the reader to see here</p></body></html>', status: 200 }),
    ];
    const s = summarizeSurfaceQuality(results);
    expect(s.total).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.failingUrls).toEqual(['/bad']);
    expect(s.warned).toBe(1);
  });
});
