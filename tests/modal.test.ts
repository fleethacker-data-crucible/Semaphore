import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isolate, isTopModal, modalKeyAction, openModalCount, popModal, pushModal, type TreeNode } from '../web/src/lib/modal.ts';

class Node implements TreeNode {
  parentElement: Node | null = null;
  children: Node[] = [];
  attrs = new Map<string, string>();
  tagName: string;
  name: string;
  constructor(tagName: string, name = '') {
    this.tagName = tagName;
    this.name = name;
  }
  add(...kids: Node[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
}

/** html > body > [script, #root > [header, main, backdrop > dialog], toast] */
function page() {
  const html = new Node('HTML');
  const body = new Node('BODY');
  const root = new Node('DIV', 'root');
  const header = new Node('HEADER', 'header');
  const main = new Node('MAIN', 'main');
  const dialog = new Node('SECTION', 'dialog');
  const backdrop = new Node('DIV', 'backdrop').add(dialog);
  const toast = new Node('DIV', 'toast');
  const script = new Node('SCRIPT', 'script');
  html.add(body);
  body.add(script, root, toast);
  root.add(header, main, backdrop);
  return { html, body, root, header, main, backdrop, dialog, toast, script };
}

const inert = (n: Node) => n.getAttribute('inert') !== null && n.getAttribute('aria-hidden') === 'true';

test('Escape closes; Tab wraps at both ends and stays put in between', () => {
  assert.equal(modalKeyAction('Escape', false, 2, 5), 'close');
  assert.equal(modalKeyAction('Tab', false, 4, 5), 'to-first');
  assert.equal(modalKeyAction('Tab', true, 0, 5), 'to-last');
  assert.equal(modalKeyAction('Tab', false, 1, 5), null);
  assert.equal(modalKeyAction('Tab', true, 3, 5), null);
  assert.equal(modalKeyAction('a', false, 0, 5), null);
  assert.equal(modalKeyAction('Enter', false, 0, 5), null);
});

test('Tab with focus outside the dialog, or nothing to focus, is pulled back in', () => {
  assert.equal(modalKeyAction('Tab', false, -1, 3), 'to-first');
  assert.equal(modalKeyAction('Tab', true, -1, 3), 'to-last');
  assert.equal(modalKeyAction('Tab', false, -1, 0), 'to-dialog');
  assert.equal(modalKeyAction('Tab', true, 0, 0), 'to-dialog');
  assert.equal(modalKeyAction('Tab', false, 0, 1), 'to-first');
  assert.equal(modalKeyAction('Tab', true, 0, 1), 'to-last');
});

test('only the top-most modal answers keys, and the next one takes over when it closes', () => {
  const a = Symbol('a');
  const b = Symbol('b');
  const before = openModalCount();
  pushModal(a);
  pushModal(b);
  assert.equal(isTopModal(b), true);
  assert.equal(isTopModal(a), false);
  popModal(b);
  assert.equal(isTopModal(a), true);
  popModal(a);
  popModal(a);
  assert.equal(openModalCount(), before);
});

test('everything outside the dialog becomes inert and hidden; the dialog and its ancestors do not', () => {
  const p = page();
  const restore = isolate(p.dialog);
  for (const n of [p.header, p.main, p.toast]) assert.ok(inert(n), n.name);
  for (const n of [p.dialog, p.backdrop, p.root, p.body]) assert.equal(n.getAttribute('inert'), null, `${n.name} must stay live`);
  assert.equal(p.script.getAttribute('inert'), null, 'scripts are left alone');
  restore();
  for (const n of [p.header, p.main, p.toast]) assert.deepEqual([n.getAttribute('inert'), n.getAttribute('aria-hidden')], [null, null], n.name);
});

test('restoring puts back what was there before, not just removes', () => {
  const p = page();
  p.main.setAttribute('aria-hidden', 'false');
  p.header.setAttribute('inert', '');
  const restore = isolate(p.dialog);
  assert.equal(p.main.getAttribute('aria-hidden'), 'true');
  restore();
  assert.equal(p.main.getAttribute('aria-hidden'), 'false');
  assert.equal(p.main.getAttribute('inert'), null);
  assert.equal(p.header.getAttribute('inert'), '');
  assert.equal(p.header.getAttribute('aria-hidden'), null);
});

test('a second modal over the first isolates the first, and closing in either order leaves the page as it was', () => {
  const p = page();
  const second = new Node('SECTION', 'second');
  const backdrop2 = new Node('DIV', 'backdrop2').add(second);
  p.root.add(backdrop2);
  const r1 = isolate(p.dialog);
  const r2 = isolate(second);
  assert.ok(inert(p.backdrop), 'the first overlay is behind the second');
  assert.equal(second.getAttribute('inert'), null);
  r2();
  assert.equal(p.backdrop.getAttribute('inert'), null, 'the first is live again');
  assert.ok(inert(p.header), 'the builder is still behind the first');
  r1();
  for (const n of [p.header, p.main, p.toast, p.backdrop, backdrop2]) assert.deepEqual([n.getAttribute('inert'), n.getAttribute('aria-hidden')], [null, null], n.name);
});

test('every overlay uses the shared helper with a name, aria-modal and a way to take focus (source check)', () => {
  const files: Array<[string, string]> = [
    ['ShareDialog.tsx', 'Export or share'],
    ['SqlDesk.tsx', 'SQL desk'],
    ['DataPanel.tsx', 'Data and catalog'],
    ['LineageView.tsx', 'Lineage'],
    ['QlikImport.tsx', 'Import from Qlik'],
    ['ModelImport.tsx', 'Import a model'],
    ['PlaybookPanel.tsx', 'Playbook'],
    ['Reports.tsx', 'edition.title'],
  ];
  for (const [file, name] of files) {
    const src = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8');
    assert.match(src, /useModal\(dialogRef, /, `${file} does not use useModal`);
    assert.match(src, /ref=\{dialogRef\} role="dialog" aria-modal="true" tabIndex=\{-1\}/, `${file} dialog markup`);
    assert.ok(src.includes(name), `${file} lost its name ${name}`);
  }
  const share = readFileSync(new URL('../web/src/components/ShareDialog.tsx', import.meta.url), 'utf8');
  assert.match(share, /data-autofocus={format === f.id/);
  const sql = readFileSync(new URL('../web/src/components/SqlDesk.tsx', import.meta.url), 'utf8');
  assert.match(sql, /<textarea\s+data-autofocus/);
});

test('the helper restores focus to the opener only after the page is live again (source check)', () => {
  const src = readFileSync(new URL('../web/src/lib/modal.ts', import.meta.url), 'utf8');
  assert.ok(src.indexOf('restore();') < src.indexOf('opener.focus()'), 'focus must go back after the inert attributes are removed');
  assert.match(src, /addEventListener\('keydown', onKey, true\)/);
  assert.match(src, /removeEventListener\('keydown', onKey, true\)/);
});
