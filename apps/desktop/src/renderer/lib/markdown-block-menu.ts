import { ChangeSet, EditorSelection, Facet, Prec, type EditorState, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { SyntaxNode, Tree } from '@lezer/common';
import { markdownTransformRange, type MarkdownCommandName } from '../../../../../packages/markdown/src/commands';

type Action = MarkdownCommandName | 'moveUp' | 'moveDown';
const actions: ReadonlyArray<[Action, string, string]> = [
  ['heading1', '一级标题', 'h1 title'],
  ['heading2', '二级标题', 'h2 heading'],
  ['heading3', '三级标题', 'h3 heading'],
  ['bullet', '无序列表', 'list bullet'],
  ['ordered', '有序列表', 'numbered list'],
  ['task', '待办事项', 'todo task checkbox'],
  ['table', '表格', 'table grid'],
  ['quote', '引用', 'quote'],
  ['codeBlock', '代码块', 'code fence'],
  ['link', '链接', 'link'],
  ['image', '图片', 'image'],
  ['mathBlock', '公式块', 'math latex'],
  ['mermaid', 'Mermaid 图表', 'diagram chart'],
  ['callout', '提示块', 'alert note'],
  ['footnote', '脚注', 'footnote'],
  ['wikiLink', '文档链接', 'wiki wikilink'],
  ['definition', '术语释义', 'definition'],
  ['citation', '参考文献引用', 'cite citation bibliography'],
  ['toc', '目录', 'toc outline'],
  ['rule', '分隔线', 'divider'],
  ['frontmatter', '文档信息', 'yaml'],
];
const headingLevel = (node: SyntaxNode) => Number(/^(?:Setext|ATX)Heading([1-6])$/.exec(node.name)?.[1] ?? 0);
function nodeAt(state: EditorState, pos: number, parsed?: Tree) {
  const line = state.doc.lineAt(pos),
    tree = parsed ?? ensureSyntaxTree(state, line.to, 25);
  if (!tree || !line.length) return;
  let node = tree.resolveInner(pos, pos === line.to ? -1 : 1);
  while (node.parent && node.parent.name !== 'Document' && node.name !== 'ListItem') node = node.parent;
  return node.name === 'Document' ? undefined : node;
}
function spanOf(state: EditorState, node: SyntaxNode) {
  let last = node;
  const level = headingLevel(node);
  if (level)
    for (
      let next = node.nextSibling;
      next && !(headingLevel(next) && headingLevel(next) <= level);
      next = next.nextSibling
    )
      last = next;
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(last.to).to, last };
}
function adjacent(state: EditorState, node: SyntaxNode, down: boolean) {
  if (down) return spanOf(state, node).last.nextSibling;
  let prev = node.prevSibling;
  const level = headingLevel(node);
  if (level) while (prev && (!headingLevel(prev) || headingLevel(prev) > level)) prev = prev.prevSibling;
  return prev;
}
function moveBlock(view: EditorView, pos: number, target: SyntaxNode | null | undefined) {
  const { state } = view;
  if (!target) return false;
  // A viewport-limited parse can end in the middle of a chapter. Only an
  // explicit move needs the full extent of both blocks.
  const tree = ensureSyntaxTree(state, state.doc.length, 75);
  if (!tree) {
    window.dispatchEvent(
      new CustomEvent('agentviewer:markdown-error', {
        detail: {
          viewId: view.dom.closest<HTMLElement>('[data-markdown-view]')?.dataset.markdownView,
          message: '文档仍在解析，暂时无法确定整块的移动范围。',
        },
      })
    );
    return false;
  }
  const node = nodeAt(state, pos, tree);
  target = nodeAt(state, target.from, tree);
  if (!node || !target || node.parent?.from !== target.parent?.from || node.parent?.name !== target.parent?.name)
    return false;
  const source = spanOf(state, node),
    dest = spanOf(state, target);
  if (source.from <= dest.to && source.to >= dest.from) return false;
  const down = source.from < dest.from,
    start = Math.min(source.from, dest.from),
    end = Math.max(source.to, dest.to);
  const body = state.sliceDoc(source.from, source.to),
    rest = down ? state.sliceDoc(source.to, end) : state.sliceDoc(start, source.from);
  const gap = (down ? /^(?:\n[ \t]*(?=\n))*\n/ : /\n(?:[ \t]*\n)*$/).exec(rest)?.[0];
  if (!gap) return false;
  const insert = down ? rest.slice(gap.length) + gap + body : body + gap + rest.slice(0, -gap.length);
  const anchor = start + (down ? rest.length : 0) + Math.max(0, Math.min(pos - source.from, body.length));
  view.dispatch({
    changes: { from: start, to: end, insert },
    selection: EditorSelection.cursor(anchor),
    annotations: isolateHistory.of('full'),
    userEvent: 'move.block',
    scrollIntoView: true,
  });
  return true;
}
const live = Facet.define<() => boolean>();
const enabled = (view: EditorView) => !view.state.readOnly && !!view.state.facet(live)[0]?.();
type Trigger = { from: number; to: number; query: string; explicit: boolean };
const controls = ViewPlugin.fromClass(
  class {
    readonly handle = document.createElement('button');
    readonly menu = document.createElement('div');
    readonly list = document.createElement('div');
    readonly search = document.createElement('input');
    readonly owner = this.handle.ownerDocument;
    target = 0;
    trigger?: Trigger;
    active = 0;
    options: ReadonlyArray<[Action, string, string]> = [];
    dismissed?: { doc: Text; pos: number };
    drag?: { doc: Text; pos: number };
    frame = 0;
    showHandle = false;
    readonly indicator = document.createElement('div');
    constructor(readonly view: EditorView) {
      this.handle.type = 'button';
      this.handle.className = 'md-block-handle';
      this.handle.hidden = true;
      this.handle.setAttribute('aria-keyshortcuts', 'Control+Alt+/');
      this.handle.setAttribute('aria-haspopup', 'dialog');
      this.handle.onmousedown = (e) => {
        e.stopPropagation();
        if (!this.handle.draggable) e.preventDefault();
      };
      this.handle.onclick = () => this.open(this.target);
      this.handle.ondragstart = (e) => {
        if (!e.dataTransfer) return;
        this.close();
        this.drag = { doc: view.state.doc, pos: this.target };
        e.dataTransfer.setData('application/x-agentviewer-block', 'move');
        e.dataTransfer.effectAllowed = 'move';
      };
      this.handle.ondragend = () => {
        this.drag = undefined;
        this.indicator.hidden = true;
      };
      this.indicator.className = 'md-block-drop';
      this.indicator.hidden = true;
      view.dom.append(this.handle, this.indicator);
      this.menu.className = 'md-block-menu';
      this.menu.hidden = true;
      this.menu.setAttribute('role', 'dialog');
      this.menu.setAttribute('aria-label', '内容块命令');
      this.list.id = 'md-block-' + crypto.randomUUID();
      this.list.setAttribute('role', 'listbox');
      this.list.setAttribute('aria-label', '插入与整理内容块');
      this.search.type = 'search';
      this.search.setAttribute('aria-label', '筛选内容块命令');
      this.search.placeholder = '查找命令';
      this.search.setAttribute('role', 'combobox');
      this.search.setAttribute('aria-expanded', 'true');
      this.search.setAttribute('aria-controls', this.list.id);
      this.search.oninput = () => {
        if (this.trigger) {
          this.trigger.query = this.search.value;
          this.render();
        }
      };
      this.search.onkeydown = (e) => {
        if (this.key(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      this.menu.append(this.search, this.list);
      this.owner.body.append(this.menu);
      view.dom.addEventListener('compositionend', this.endComposition);
      view.dom.addEventListener('pointermove', this.hover);
      view.dom.addEventListener('pointerleave', this.leave);
      view.dom.addEventListener('dragover', this.dragOver);
      view.dom.addEventListener('drop', this.drop, true);
      this.owner.addEventListener('pointerdown', this.outside, true);
      this.owner.addEventListener('scroll', this.layout, true);
      window.addEventListener('resize', this.layout);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.reconfigured)) {
        if (!enabled(this.view) || (this.trigger?.explicit && (u.docChanged || u.selectionSet))) this.close();
        if (!this.trigger?.explicit) this.detect();
        if (
          u.focusChanged &&
          !this.view.hasFocus &&
          this.owner.activeElement !== this.handle &&
          !this.trigger?.explicit
        )
          this.showHandle = false;
        if (u.docChanged || u.selectionSet) this.target = u.state.selection.main.head;
        this.layout();
      } else if (u.geometryChanged) this.layout();
    }
    detect() {
      const v = this.view,
        range = v.state.selection.main;
      if (
        !enabled(v) ||
        !v.hasFocus ||
        !range.empty ||
        v.compositionStarted ||
        (this.dismissed?.doc === v.state.doc && this.dismissed.pos === range.head)
      ) {
        this.close();
        return;
      }
      const line = v.state.doc.lineAt(range.head);
      if (line.length > 80 || range.head !== line.to) {
        this.close();
        return;
      }
      const match = /^ {0,3}\/([^\s/\\]*)$/.exec(line.text);
      if (!match) {
        this.close();
        return;
      }
      const tree = ensureSyntaxTree(v.state, line.to, 20);
      if (!tree) {
        this.close();
        return;
      }
      for (let n = tree.resolveInner(line.to, -1); n; n = n.parent!)
        if (
          ['CodeBlock', 'FencedCode', 'InlineCode', 'BlockMath', 'Frontmatter', 'HTMLBlock', 'Table'].includes(
            n.name
          )
        ) {
          this.close();
          return;
        }
      this.trigger = { from: line.to - match[1].length - 1, to: line.to, query: match[1], explicit: false };
      this.render();
    }
    open(pos: number) {
      if (!enabled(this.view) || this.view.compositionStarted) return;
      this.dismissed = undefined;
      this.target = pos;
      this.trigger = { from: pos, to: pos, query: '', explicit: true };
      this.search.value = '';
      this.render();
      this.search.focus({ preventScroll: true });
    }
    close() {
      if (!this.trigger) return;
      this.trigger = undefined;
      this.menu.hidden = true;
      this.view.contentDOM.removeAttribute('aria-activedescendant');
      this.view.contentDOM.removeAttribute('aria-controls');
    }
    render() {
      const t = this.trigger;
      if (!t) return;
      const list = [...actions];
      if (t.explicit) {
        const node = nodeAt(this.view.state, t.from);
        if (node)
          for (const down of [false, true]) {
            const next = adjacent(this.view.state, node, down);
            if (
              next &&
              (down ? spanOf(this.view.state, node).to < next.from : spanOf(this.view.state, next).to < node.from)
            )
              list.unshift([
                down ? 'moveDown' : 'moveUp',
                (down ? '下移' : '上移') + (headingLevel(node) ? '章节' : '内容块'),
                down ? 'move down' : 'move up',
              ]);
          }
      }
      this.options = list.filter(([id, label, keywords]) =>
        (label + ' ' + keywords + ' ' + id).toLowerCase().includes(t.query.toLowerCase())
      );
      this.active = 0;
      this.search.hidden = !t.explicit;
      this.menu.hidden = false;
      this.list.replaceChildren(
        ...this.options.map(([id, label], index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.tabIndex = -1;
          button.id = this.list.id + '-' + index;
          button.setAttribute('role', 'option');
          button.dataset.command = id;
          button.textContent = label;
          button.onmousedown = (e) => e.preventDefault();
          button.onpointermove = () => this.select(index, false);
          button.onclick = () => this.apply(index);
          return button;
        })
      );
      if (!this.options.length) {
        const empty = document.createElement('div');
        empty.className = 'md-no-command';
        empty.textContent = '没有匹配命令';
        this.list.append(empty);
      }
      this.select(0, false);
      this.layout();
    }
    select(index: number, scroll: boolean) {
      this.active = index;
      const field = this.trigger?.explicit ? this.search : this.view.contentDOM;
      field.setAttribute('aria-controls', this.list.id);
      for (const [i, el] of [...this.list.querySelectorAll('button')].entries())
        el.setAttribute('aria-selected', String(i === index));
      const current = this.list.children[index];
      if (current?.id) {
        field.setAttribute('aria-activedescendant', current.id);
        if (scroll) current.scrollIntoView({ block: 'nearest' });
      } else field.removeAttribute('aria-activedescendant');
    }
    key(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229 || this.view.compositionStarted) return false;
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === 'Slash' && enabled(this.view)) {
        this.open(this.view.state.selection.main.head);
        return true;
      }
      if (!this.trigger) return false;
      if (e.key === 'Escape') {
        this.dismissed = { doc: this.view.state.doc, pos: this.view.state.selection.main.head };
        this.close();
        this.view.focus();
        return true;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = this.options.length;
        if (n) this.select((this.active + n + (e.key === 'ArrowDown' ? 1 : -1)) % n, true);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (this.options.length) {
          this.apply(this.active);
          return true;
        }
        this.close();
        return false;
      }
      return false;
    }
    apply(index: number) {
      const t = this.trigger,
        option = this.options[index];
      if (!t || !option || this.view.compositionStarted) return;
      const v = this.view,
        state = v.state,
        [id] = option;
      this.close();
      if (id === 'moveUp' || id === 'moveDown') {
        const node = nodeAt(state, t.from);
        if (node) moveBlock(v, t.from, adjacent(state, node, id === 'moveDown'));
      } else {
        const erase = state.changes({ from: t.from, to: t.to, insert: '' }),
          doc = erase.apply(state.doc);
        const paragraph = /^(heading\d|bullet|ordered|task|quote)$/.test(id);
        const node = t.explicit && nodeAt(state, t.from);
        const position = t.explicit && node && !paragraph ? node.to : t.from;
        const edit = markdownTransformRange(doc, position, position, id);
        const formatted = erase.compose(
          ChangeSet.of({ from: edit.from, to: edit.to, insert: edit.insert }, doc.length)
        );
        v.dispatch({
          changes: formatted,
          selection: edit.selection
            ? EditorSelection.range(edit.selection.anchor, edit.selection.head)
            : undefined,
          annotations: isolateHistory.of('full'),
          userEvent: 'input.block-menu',
          scrollIntoView: true,
        });
      }
      v.focus();
    }
    endComposition = () => {
      queueMicrotask(() => {
        if (this.view.dom.isConnected && !this.trigger?.explicit) this.detect();
      });
    };
    hover = (e: PointerEvent) => {
      if (!enabled(this.view) || e.buttons || this.trigger || this.handle.contains(e.target as Node)) return;
      const line = (e.target as Element).closest('.cm-line,.md-measured-block');
      if (line) {
        const pos = this.view.posAtDOM(line);
        if (this.showHandle && pos === this.target) return;
        this.target = pos;
        this.showHandle = true;
        this.layout();
      }
    };
    leave = (event: PointerEvent) => {
      if (!event.buttons) {
        this.showHandle = false;
        this.layout();
      }
    };
    outside = (e: PointerEvent) => {
      if (this.trigger && !this.menu.contains(e.target as Node) && !this.handle.contains(e.target as Node))
        this.close();
    };
    dragOver = (e: DragEvent) => {
      if (!this.drag || this.drag.doc !== this.view.state.doc) return;
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }),
        node = pos === null ? null : nodeAt(this.view.state, pos);
      if (!node) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const span = spanOf(this.view.state, node),
        rect = this.view.coordsAtPos(this.drag.pos < span.from ? span.to : span.from);
      if (rect) {
        this.indicator.hidden = false;
        this.indicator.style.top =
          (this.drag.pos < span.from ? rect.bottom : rect.top) - this.view.dom.getBoundingClientRect().top + 'px';
      }
    };
    drop = (e: DragEvent) => {
      if (!this.drag) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null && this.drag.doc === this.view.state.doc)
        moveBlock(this.view, this.drag.pos, nodeAt(this.view.state, pos));
      this.drag = undefined;
      this.indicator.hidden = true;
      this.view.focus();
    };
    layout = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const v = this.view,
          t = this.trigger;
        const pos = Math.min(t?.from ?? this.target, v.state.doc.length),
          line = v.state.doc.lineAt(pos);
        this.handle.hidden = !enabled(v) || !this.showHandle || !!t || !v.state.selection.main.empty;
        if (this.handle.hidden && !t) return;
        const rect = v.coordsAtPos(t ? pos : line.from),
          box = v.dom.getBoundingClientRect();
        if (!rect) {
          this.handle.hidden = true;
          this.close();
          return;
        }
        if (!this.handle.hidden) {
          this.handle.style.left = Math.max(0, parseFloat(getComputedStyle(v.contentDOM).paddingLeft) - 27) + 'px';
          this.handle.style.top = rect.top - box.top + 'px';
          this.handle.textContent = line.length ? '⠿' : '+';
          this.handle.draggable = !!line.length;
          const label = line.length ? '整理或插入内容块' : '插入内容块';
          this.handle.setAttribute('aria-label', label);
          this.handle.title = label + ' · Ctrl+Alt+/';
        }
        if (t) {
          const m = this.menu.getBoundingClientRect();
          this.menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - m.width - 8)) + 'px';
          this.menu.style.top =
            (rect.bottom + m.height + 8 <= innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - m.height - 4)) +
            'px';
        }
      });
    };
    destroy() {
      cancelAnimationFrame(this.frame);
      this.menu.remove();
      this.handle.remove();
      this.indicator.remove();
      const dom = this.view.dom;
      dom.removeEventListener('compositionend', this.endComposition);
      dom.removeEventListener('pointermove', this.hover);
      dom.removeEventListener('pointerleave', this.leave);
      dom.removeEventListener('dragover', this.dragOver);
      dom.removeEventListener('drop', this.drop, true);
      this.owner.removeEventListener('pointerdown', this.outside, true);
      this.owner.removeEventListener('scroll', this.layout, true);
      window.removeEventListener('resize', this.layout);
    }
  }
);
export const blockMenuExtension = (isLive: () => boolean) => [live.of(isLive), controls];
export const blockMenuKey = Prec.highest(
  EditorView.domEventHandlers({ keydown: (event, view) => view.plugin(controls)?.key(event) ?? false })
);
