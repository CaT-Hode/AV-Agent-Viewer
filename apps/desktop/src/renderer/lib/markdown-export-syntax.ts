/*!
 * Delimiter resolution adapted from micromark-extension-gfm-strikethrough.
 * Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type { Construct, Event, Extension, Resolver, State, Token, Tokenizer, TokenType } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Processor } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    avHighlight: 'avHighlight'; avHighlightSequence: 'avHighlightSequence'; avHighlightTemporary: 'avHighlightTemporary'; avHighlightText: 'avHighlightText';
    avSub: 'avSub'; avSubSequence: 'avSubSequence'; avSubTemporary: 'avSubTemporary'; avSubText: 'avSubText';
    avSuper: 'avSuper'; avSuperSequence: 'avSuperSequence'; avSuperTemporary: 'avSuperTemporary'; avSuperText: 'avSuperText';
  }
}
declare module 'unified' {
  interface Data { micromarkExtensions?: Extension[]; fromMarkdownExtensions?: FromMarkdownExtension[] }
}

/** Resolve source delimiters before mdast text is decoded or split around
 * strong/emphasis. Micromark owns escapes, entities, links and code spans; the
 * resulting nodes keep all nested children and their original positions. */
function delimiter(name: 'avHighlight' | 'avSub' | 'avSuper', marker: number, width: number): Extension {
  const temporary = (name + 'Temporary') as TokenType, sequence = (name + 'Sequence') as TokenType, content = (name + 'Text') as TokenType;
  const resolve: Resolver = (events, context) => {
    for (let close = 0; close < events.length; close++) {
      const closer = events[close][1];
      if (events[close][0] !== 'enter' || closer.type !== temporary || !closer._close) continue;
      for (let open = close - 1; open >= 0; open--) {
        const opener = events[open][1];
        if (events[open][0] !== 'exit' || opener.type !== temporary || !opener._open || opener.end.offset === closer.start.offset || opener.end.line !== closer.start.line) continue;
        opener.type = closer.type = sequence;
        const wrapper: Token = { type: name, start: { ...opener.start }, end: { ...closer.end } };
        const inside: Token = { type: content, start: { ...opener.end }, end: { ...closer.start } };
        const resolved: Event[] = [['enter', wrapper, context], ['enter', opener, context], ['exit', opener, context], ['enter', inside, context]];
        splice(resolved, resolved.length, 0, resolveAll(context.parser.constructs.insideSpan.null ?? [], events.slice(open + 1, close), context));
        splice(resolved, resolved.length, 0, [['exit', inside, context], ['enter', closer, context], ['exit', closer, context], ['exit', wrapper, context]]);
        splice(events, open - 1, close - open + 3, resolved); close = open + resolved.length - 2; break;
      }
    }
    for (const event of events) if (event[1].type === temporary) event[1].type = 'data';
    return events;
  };
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const previous = this.previous, events = this.events; let count = 0;
    const more: State = code => {
      if (code === marker) { if (count === width) return nok(code); effects.consume(code); count++; return more; }
      if (count !== width) return nok(code);
      const token = effects.exit(temporary);
      const before = classifyCharacter(previous), after = classifyCharacter(code);
      token._open = after !== 1 && (after !== 2 || before === 1 || before === 2);
      token._close = before !== 1 && (before !== 2 || after === 1 || after === 2);
      return ok(code);
    };
    return code => { if (previous === marker && events.at(-1)?.[1].type !== 'characterEscape') return nok(code); effects.enter(temporary); return more(code); };
  };
  const construct: Construct = { name, tokenize, resolveAll: resolve };
  return { text: { [marker]: construct }, insideSpan: { null: [construct] }, attentionMarkers: { null: [marker] } };
}

export function typoraInlineSyntax(this: Processor) {
  const syntax = [delimiter('avHighlight', 61, 2), delimiter('avSub', 126, 1), delimiter('avSuper', 94, 1)];
  const fromMarkdown: FromMarkdownExtension = { enter: {}, exit: {} };
  for (const [name, tag] of [['avHighlight', 'mark'], ['avSub', 'sub'], ['avSuper', 'sup']] as const) {
    fromMarkdown.enter![name] = function (token) { this.enter({ type: 'emphasis', children: [], data: { hName: tag } }, token); };
    fromMarkdown.exit![name] = function (token) { this.exit(token); };
  }
  const data = this.data();
  (data.micromarkExtensions ??= []).push(...syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
