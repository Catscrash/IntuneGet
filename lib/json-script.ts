/**
 * Serialize a value for embedding inside a <script> element
 *
 * The HTML parser ends a script element at the first `</script`, whatever the
 * JavaScript or JSON context around it, and JSON.stringify() escapes neither
 * `<` nor `/`. A value carrying that sequence - an app name, publisher or
 * description that reaches us from an upstream winget manifest, say - would
 * therefore close the tag early and have everything after it parsed as markup,
 * script tags included.
 *
 * Escaping `<`, `>` and `&` as \uXXXX removes the breakout while leaving valid
 * JSON that parses back to exactly the same value, so JSON-LD consumers see no
 * difference. U+2028 and U+2029 are escaped as well: JSON allows them raw in a
 * string, JavaScript treats them as line terminators.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
