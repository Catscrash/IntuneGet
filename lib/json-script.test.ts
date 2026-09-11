import { describe, expect, it } from 'vitest';
import { jsonForScript } from './json-script';

describe('jsonForScript', () => {
  it('leaves no sequence that can close a script element', () => {
    const payload = {
      name: 'Vendor App</script><script>window.__xssFired = true</script>',
    };

    const embedded = jsonForScript(payload);

    expect(embedded.toLowerCase()).not.toContain('</script');
    expect(embedded).not.toContain('<');
    expect(embedded).not.toContain('>');
  });

  it('parses back to exactly the value that went in', () => {
    const payload = {
      '@context': 'https://schema.org',
      name: 'A & B <tag> "quoted"   line',
      description: 'ends with </script>',
      nested: [{ url: 'https://example.test/apps/Vendor.App?a=1&b=2' }],
    };

    expect(JSON.parse(jsonForScript(payload))).toEqual(payload);
  });

  it('escapes the line terminators JSON allows raw but JavaScript does not', () => {
    const embedded = jsonForScript({ note: 'before after end' });

    expect(embedded).toContain('\\u2028');
    expect(embedded).toContain('\\u2029');
    expect(embedded).not.toContain(' ');
    expect(embedded).not.toContain(' ');
  });

  it('escapes ampersands so an entity cannot be reconstructed', () => {
    expect(jsonForScript({ q: 'a&lt;b' })).toContain('\\u0026');
  });
});
