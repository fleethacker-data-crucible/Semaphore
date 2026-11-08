// Leadership Q&A: drafted answers and their review, alerts on colour rules, the answer-quality
// numbers, and the briefing as an email (.eml).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Alert, alertReading, alertTarget, alertText, forBriefing, isAlert, markBriefed, markSeen, newAlert, parseAlertRequest, primeAlert, stepAlert, unseen } from '../src/core/alerts.ts';
import { answerQuality, durationText, percentile } from '../src/core/answer-quality.ts';
import { base64, briefingMailHtml, briefingMailText, cleanRecipients, composeEml, headerValue } from '../src/core/briefing-mail.ts';
import { runPlan } from '../src/core/engine.ts';
import { type AskLog, bumpAsk, DRAFTED_ASK, impactFor, isoWeek, withUses } from '../src/core/impact.ts';
import { answerQuestion, isQuestion, learnFromHoist, newQuestion, type QuestionItem, resolveQuestions } from '../src/core/playbook.ts';
import { acceptDraft, ASK_HOIST, canAskForReview, dataAccessNote, draftFlag, draftOf, draftsWaiting, rejectDraft, requestReview, reviewAsked, TRUST_LABELS } from '../src/core/review.ts';
import { type Snapshot, takeSnapshot } from '../src/core/snapshot.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const today = new Date('2026-10-26T12:00:00Z');
const tables = fleetSampleRows(today);
const entries = learnFromHoist([], hoist, index, 'dana', today);
const cost = entries.find((e) => e.id.endsWith('kpi-cost'))!;
const region = entries.find((e) => e.id.endsWith('bar-region'))!;

// ---------------------------------------------------------------------------------------------
// Drafted answers: labelling and queueing

test('drafted answers are labelled apart from reviewed ones, in words a screen reader hears too', () => {
  assert.equal(TRUST_LABELS.drafted.label, 'Drafted — not yet reviewed');
  assert.equal(TRUST_LABELS.drafted.reviewed, false);
  assert.match(TRUST_LABELS.drafted.sr, /No analyst has reviewed it/);
  assert.equal(TRUST_LABELS.reviewed.reviewed, true);
  assert.equal(TRUST_LABELS.adjusted.reviewed, true);
  assert.notEqual(TRUST_LABELS.drafted.label, TRUST_LABELS.reviewed.label);
  // Never claims row security Semaphore does not have.
  for (const from of ['live', 'snapshot'] as const) assert.match(dataAccessNote(from), /no row-level security of its own/);
  assert.match(dataAccessNote('live'), /your own database sign-in from Lazarette/);
});

test('"Ask for review" is offered only on a drafted answer shown with numbers', () => {
  assert.equal(canAskForReview('drafted', 'ready'), true);
  assert.equal(canAskForReview('drafted', 'unanswered'), false);
  assert.equal(canAskForReview('reviewed', 'ready'), false);
  assert.equal(canAskForReview('adjusted', 'ready'), false);
});

test('a drafted answer is queued with its draft, counted once per asker, and never becomes an entry by itself', () => {
  const answer = answerQuestion('work orders by ship class', entries, index);
  assert.equal(answer.trust, 'drafted');
  assert.equal(answer.entry, undefined);
  const draft = draftOf(answer, 'live', 'local rules', today)!;
  assert.ok(draft.binding.metrics.includes('work_orders'));
  assert.equal(draftOf(answerQuestion('Total labor cost. Turn red over $5M.', entries, index), 'snapshot'), null, 'a reviewed answer has no draft');

  const q = requestReview([], answer, 'lee', draft, today);
  assert.equal(q.status, 'open');
  assert.equal(q.shown, 'drafted');
  assert.ok(q.reviewRequested);
  assert.deepEqual(q.askers, ['lee']);
  assert.ok(isQuestion(q));
  assert.equal(reviewAsked([q], 'Work orders by ship class?', 'lee'), true);
  assert.equal(reviewAsked([q], 'work orders by ship class', 'kim'), false);
  // Asked again by someone else: the same question, two askers.
  const again = requestReview([q], answer, 'kim', draft, today);
  assert.equal(again.id, q.id);
  assert.deepEqual(again.askers, ['lee', 'kim']);
  // The same person again: not counted twice.
  assert.equal(requestReview([again], answer, 'kim', draft, today).askers!.length, 2);
  assert.deepEqual(draftsWaiting([again, newQuestion('x', 'a', 'none', [])]).map((x) => x.id), [q.id]);
  // Nothing about it is in the playbook: the briefing and alerts read entries only.
  assert.equal(resolveQuestions([again], entries).length, 0);
});

test('an analyst accepts a draft: a reviewed entry in the asker\'s words, and the question answered', () => {
  const answer = answerQuestion('work orders by ship class', entries, index);
  const q = requestReview([], answer, 'lee', draftOf(answer, 'live')!, today);
  const later = new Date(today.getTime() + 5 * 3_600_000);
  const done = acceptDraft(q, 'dana', index, later)!;
  assert.equal(done.entry.acceptedBy, 'dana');
  assert.equal(done.entry.hoist.id, ASK_HOIST.id);
  assert.equal(done.entry.question, q.title);
  assert.equal(done.entry.status, 'active');
  assert.equal(done.question.status, 'answered');
  assert.equal(done.question.entryId, done.entry.id);
  assert.equal(done.question.answeredAt, later.toISOString());
  assert.equal(done.question.reviewedBy, 'dana');
  // Asked again in the same words, it is now a reviewed answer.
  const next = answerQuestion('Work orders by ship class?', [...entries, done.entry], index);
  assert.equal(next.trust, 'reviewed');
  assert.equal(next.entry?.id, done.entry.id);
  // A closed question cannot be accepted twice.
  assert.equal(acceptDraft(done.question, 'dana', index), null);
});

test('an analyst can reject a draft with a reason, or take it to the builder to edit', () => {
  const answer = answerQuestion('work orders by ship class', entries, index);
  const q = requestReview([], answer, 'lee', draftOf(answer, 'live')!, today);
  const no = rejectDraft(q, 'dana', '  Ship class is not reliable before 2025.  ', today);
  assert.equal(no.status, 'dismissed');
  assert.equal(no.rejected?.reason, 'Ship class is not reliable before 2025.');
  assert.equal(rejectDraft(q, 'dana', '').rejected?.reason, 'No reason given.');
  const f = draftFlag(q, 'f1', { x: 0, y: 0, w: 4, h: 4 });
  assert.equal(f.status, 'drafted');
  assert.equal(f.brief, q.title, 'accepting it answers the question in the same words');
  assert.deepEqual(f.binding, q.draft!.binding);
  assert.equal(draftFlag(newQuestion('x', 'a', 'none', []), 'f2', { x: 0, y: 0, w: 4, h: 4 }).status, 'empty');
});

// ---------------------------------------------------------------------------------------------
// Alerts

const snap = async (scale = 1, asOf = today): Promise<Snapshot> => {
  const s = (await takeSnapshot(cost, index, async (p) => runPlan(p, index, tables, today), asOf))!;
  return { ...s, rows: s.rows.map((r) => (typeof r.a0 === 'number' ? { ...r, a0: r.a0 * scale } : r)) };
};

test('an alert is a flag, its red rule and who asked; only measures with a red rule can have one', () => {
  const a = newAlert(cost, 'labor_cost', 'lee', index, {}, today)!;
  assert.equal(a.rule.op, 'gt');
  assert.equal(a.rule.value, 5_000_000);
  assert.equal(a.who, 'lee');
  assert.equal(a.state, 'unknown');
  assert.equal(a.brief, true);
  assert.ok(isAlert(a));
  assert.equal(newAlert(region, 'labor_cost', 'lee', index), null, 'the bar has no colour rule');
  assert.equal(isAlert({ ...a, rule: { op: 'between' } }), false);
});

test('alerts fire once per change into red, optionally once back to normal, and ignore older readings', () => {
  let a: Alert = newAlert(cost, 'labor_cost', 'lee', index, { notifyClear: true }, today)!;
  a = primeAlert(a, { value: 4_000_000, asOf: '2026-10-26T10:00:00.000Z' }, today);
  assert.equal(a.state, 'normal');
  assert.equal(a.events.length, 0, 'setting it never fires');
  let r = stepAlert(a, { value: 4_500_000, asOf: '2026-10-26T11:00:00.000Z' }, 'page', today);
  assert.equal(r.fired, null);
  r = stepAlert(r.alert, { value: 6_000_000, asOf: '2026-10-26T12:00:00.000Z' }, 'refresh', today);
  assert.equal(r.fired?.kind, 'red');
  assert.equal(r.fired?.value, 6_000_000);
  assert.equal(r.fired?.source, 'refresh');
  assert.equal(r.fired?.asOf, '2026-10-26T12:00:00.000Z');
  // Still red: no second firing.
  r = stepAlert(r.alert, { value: 7_000_000, asOf: '2026-10-26T13:00:00.000Z' }, 'page', today);
  assert.equal(r.fired, null);
  // An older snapshot on another page does not undo it.
  const stale = stepAlert(r.alert, { value: 1, asOf: '2026-10-26T09:00:00.000Z' }, 'page', today);
  assert.equal(stale.alert.state, 'red');
  assert.equal(stale.fired, null);
  // Back to normal, told because notifyClear is on.
  r = stepAlert(r.alert, { value: 3_000_000, asOf: '2026-10-26T14:00:00.000Z' }, 'page', today);
  assert.equal(r.fired?.kind, 'clear');
  assert.equal(r.alert.events.length, 2);
  // Without notifyClear, going back is silent.
  const quiet = stepAlert({ ...r.alert, state: 'red', notifyClear: false }, { value: 1, asOf: '2026-10-26T15:00:00.000Z' }, 'page', today);
  assert.equal(quiet.fired, null);
  assert.equal(quiet.alert.state, 'normal');
  // No value: nothing changes but the check time.
  const none = stepAlert(r.alert, { value: null, asOf: '2026-10-26T16:00:00.000Z' }, 'page', today);
  assert.equal(none.alert.state, r.alert.state);
  // Unknown to red fires (the first reading after an alert made without one).
  const first = stepAlert(newAlert(cost, 'labor_cost', 'lee', index)!, { value: 9e6, asOf: 'x' }, 'page', today);
  assert.equal(first.fired?.kind, 'red');
  // A pending note from a pipeline is cleared by the check.
  const pend = stepAlert({ ...a, pending: { note: 'rebuilt', at: 'x' } }, { value: 1, asOf: '2026-10-27' }, 'page', today);
  assert.equal(pend.alert.pending, undefined);
});

test('the value an alert watches is read from the flag\'s snapshot; a KPI is its total', async () => {
  const a = newAlert(cost, 'labor_cost', 'lee', index)!;
  const real = alertReading(a, entries, [await snap()])!;
  assert.ok(real.value! > 5_000_000);
  const low = alertReading(a, entries, [await snap(0.1)])!;
  assert.ok(low.value! < 5_000_000);
  assert.equal(alertReading(a, entries, []), null);
  assert.equal(alertReading({ ...a, entryId: 'gone' }, entries, [await snap()]), null);
  // The full round: normal, then a refresh with the real numbers goes red.
  let al = primeAlert(a, low, today);
  const r = stepAlert(al, { ...real, asOf: new Date(today.getTime() + 1000).toISOString() }, 'refresh', today);
  assert.equal(r.fired?.kind, 'red');
  assert.match(alertText(r.alert, r.fired!), /^Labor cost went red: \$.+ \(red over \$5/);
  al = r.alert;
  assert.equal(unseen([al], 'lee').length, 1);
  assert.equal(unseen([al], 'kim').length, 0, 'only the person who asked is told');
  assert.equal(unseen([markSeen(al)], 'lee').length, 0);
  assert.equal(forBriefing([al], 'lee').length, 1);
  assert.equal(forBriefing([markBriefed(al)], 'lee').length, 0);
  assert.equal(forBriefing([{ ...al, brief: false }], 'lee').length, 0);
});

test('"Tell me when labor cost goes red" finds the reviewed flag with that rule', () => {
  assert.deepEqual(parseAlertRequest('Tell me when labor cost goes red'), { subject: 'labor cost', notifyClear: false });
  assert.deepEqual(parseAlertRequest('alert me if the labor cost turns red, and when it is back to normal'), { subject: 'labor cost', notifyClear: true });
  assert.equal(parseAlertRequest('which region cost the most?'), null);
  const t = alertTarget('labor cost', entries, index)!;
  assert.equal(t.entry.id, cost.id);
  assert.equal(t.metric, 'labor_cost');
  assert.equal(alertTarget('work orders', entries, index), null, 'no red rule on work orders');
});

// ---------------------------------------------------------------------------------------------
// Answer quality

test('percentiles and durations', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10, 1, 5, 3, 8, 2, 9, 4, 6, 7], 90), 9.1);
  assert.equal(percentile([1, 2, 3], 100), 3);
  assert.equal(durationText(null), 'none yet');
  assert.equal(durationText(0.25), '15 min');
  assert.equal(durationText(5), '5 h');
  assert.equal(durationText(72), '3 days');
});

test('answer quality: reviewed share from the ask files, time to a reviewed answer and the queue from questions', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  let asks: AskLog[] = [];
  for (let i = 0; i < 6; i++) asks = [bumpAsk(asks, 'lee', cost.id, now)];
  for (let i = 0; i < 2; i++) asks = [bumpAsk(asks, 'lee', DRAFTED_ASK, now)];
  const old: AskLog = { version: 1, kind: 'asks', id: 'asks-lee-2025-W01', user: 'lee', week: '2025-W01', counts: { [cost.id]: 100 }, updated: '' };
  const q = (id: string, askedAt: string, status: QuestionItem['status'], answeredAt?: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({ ...newQuestion(id, 'lee', 'drafted', [], new Date(askedAt)), id, status, ...(answeredAt ? { answeredAt, updated: answeredAt } : {}), ...extra });
  const questions = [
    q('a', '2026-11-02T08:00:00Z', 'answered', '2026-11-02T10:00:00Z'),
    q('b', '2026-11-03T08:00:00Z', 'answered', '2026-11-03T12:00:00Z'),
    q('c', '2026-11-04T08:00:00Z', 'answered', '2026-11-05T08:00:00Z'),
    q('d', '2026-11-06T12:00:00Z', 'open', undefined, { reviewRequested: '2026-11-06T12:00:00Z', draft: { kind: 'kpi', title: 't', binding: { metrics: ['work_orders'], dimensions: [], filters: [] }, filters: [], thresholds: [], by: 'local rules', draftedAt: '', from: 'live' } }),
    q('e', '2026-11-07T12:00:00Z', 'open'),
    q('f', '2026-11-01T00:00:00Z', 'dismissed'),
  ];
  const r = answerQuality({ asks: [...asks, old], questions, counted: true }, now);
  assert.equal(r.reviewed, 6);
  assert.equal(r.drafted, 2);
  assert.equal(r.reviewedShare, 0.75);
  assert.equal(r.answered, 3);
  assert.equal(r.medianHours, 4);
  assert.equal(Math.round(r.p90Hours! * 1000) / 1000, 20); // 2, 4 and 24 hours: 4 + 0.8 * (24 - 4)
  assert.equal(r.open, 2);
  assert.equal(r.draftsWaiting, 1);
  assert.equal(r.oldestOpenDays, 2);
  assert.equal(r.medianOpenDays, 1.5);
  // Impact off: nothing is counted, so no share is shown; the rest stands.
  const off = answerQuality({ asks, questions, counted: false }, now);
  assert.equal(off.reviewed, null);
  assert.equal(off.reviewedShare, null);
  assert.equal(off.answered, 3);
  // The drafted count never shows up as an entry's uses, or in an analyst's impact.
  assert.equal(withUses(entries, asks).find((e) => e.id === cost.id)!.uses, 6);
  assert.equal(impactFor(entries, asks, [], 'dana', 0, now)!.thisWeek, 6);
  assert.equal(isoWeek(now), asks[0]!.week);
});

// ---------------------------------------------------------------------------------------------
// The briefing as an email

const mail = { subject: 'Leadership briefing – 9 Nov', title: 'Leadership briefing', dateText: 'Monday 9 November 2026', sentences: ['Labor cost is up 12% <on> last year.'], numbers: [{ label: 'Labor cost', value: '$12.3M', note: 'Breaks its red rule' }], alerts: ['Labor cost went red: $12.3M.'], attachment: 'briefing.html', by: 'lee' };

test('the briefing body is plain HTML with every value escaped, and a text part to match', () => {
  const html = briefingMailHtml(mail);
  assert.match(html, /<h1[^>]*>Leadership briefing<\/h1>/);
  assert.match(html, /&lt;on&gt;/);
  assert.doesNotMatch(html, /<script|<img|<link/i);
  assert.match(html, /Only answers an analyst has reviewed are included/);
  assert.match(html, /\$12\.3M/);
  const text = briefingMailText(mail);
  assert.match(text, /- Labor cost went red: \$12\.3M\./);
  assert.match(text, /Headline numbers\r\n- Labor cost: \$12\.3M \(Breaks its red rule\)/);
});

test('.eml: an unsent draft with the body and the report attached, no sender, recipients checked', () => {
  const eml = composeEml({ to: ['a@example.org', 'not an address', 'A@example.org', 'b@example.org'], subject: mail.subject, html: '<p>Hi</p>', text: 'Hi', attachments: [{ name: 'briefing.html', contentType: 'text/html; charset=utf-8', content: '<!doctype html><p>réport</p>' }], date: new Date('2026-11-09T08:00:00Z'), boundary: 'b1' });
  const lines = eml.split('\r\n');
  assert.equal(lines[0], 'To: a@example.org, b@example.org');
  assert.ok(lines.includes('X-Unsent: 1'));
  assert.ok(lines.includes('MIME-Version: 1.0'));
  assert.ok(!lines.some((l) => /^From:/i.test(l)), 'the mail app fills in the sender');
  assert.ok(lines.includes('Date: Mon, 09 Nov 2026 08:00:00 +0000'));
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
  assert.match(eml, /Content-Type: multipart\/mixed; boundary="b1-mixed"/);
  assert.match(eml, /Content-Disposition: attachment; filename="briefing.html"/);
  assert.ok(eml.includes(base64(new TextEncoder().encode('<p>Hi</p>'))));
  assert.ok(eml.trimEnd().endsWith('--b1-mixed--'));
  assert.ok(eml.split('\r\n').every((l) => l.length <= 998));
  // The attachment decodes back to the report, accents and all.
  const part = eml.split('filename="briefing.html"')[1]!.split('--b1-mixed--')[0]!.replace(/\s+/g, '');
  assert.equal(Buffer.from(part, 'base64').toString('utf8'), '<!doctype html><p>réport</p>');
  assert.equal(headerValue('Plain subject'), 'Plain subject');
  assert.equal(Buffer.from(headerValue('Café').slice(10, -2), 'base64').toString('utf8'), 'Café');
  assert.deepEqual(cleanRecipients([' x@y.co ', 'x@y.co', 'bad@', 'evil@x.co\r\nBcc: z@z.co']), ['x@y.co']);
  assert.equal(base64(new TextEncoder().encode('Ma')), Buffer.from('Ma').toString('base64'));
});
