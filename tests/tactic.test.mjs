import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combatResult, damageMoments, defaultBuild } from '../calc.mjs';
import { prepareTeam, raidEnemy, teamContext } from '../team.mjs';
import { normalTiming, phaseProfile, pointAt, simulateTactic } from '../tactic.mjs';

const data = JSON.parse(await readFile(new URL('../data/global.json', import.meta.url), 'utf8'));
const raids = JSON.parse(await readFile(new URL('../data/raids.json', import.meta.url), 'utf8'));
const member = id => { const student = data.students.find(s => s.Id === id); return { student, build: defaultBuild(student, data.meta.region) }; };
const aru = member(10000);
const support = data.students.find(s => s.Name === '히마리');
const hm = { student: support, build: { ...defaultBuild(support, data.meta.region), skills: { Ex: 5, Passive: 10, ExtraPassive: 10, Public: 10, Normal: 1 } } };
const enemy = { level: 1, defense: 0, armor: 'LightArmor', terrain: 'Street', critResist: 100, critDmgResist: 50, evasion: 0 };
const phases = [{ name: 'test', hp: 1e9, enemy, wait: 0, received: 100 }];

test('Uniform stability moments and soft cap crossing have independent analytic fixtures', () => {
  const m = damageMoments(10, 20);
  assert.equal(m.mean, 15); assert.ok(Math.abs(m.second - 700 / 3) < 1e-10);
  const cap = damageMoments(3999990, 4000010, false);
  assert.equal(cap.mean, 3999997.5);
  const continuous = damageMoments(4000000, 4001000);
  assert.equal(continuous.mean, 4000400);
});

test('Never-critical ceiling cannot use the critical multiplier; independent miss variance', () => {
  const skill = {}, effect = { Type: 'Damage', Scale: [10000], CriticalCheck: 'Never', CanEvade: false };
  const result = combatResult(aru.student, aru.build, data, skill, effect, 1, enemy);
  assert.equal(result.ceiling, result.nonCrit.max);
  const missed = combatResult(aru.student, aru.build, data, skill, { ...effect, CanEvade: true }, 1, { ...enemy, evasion: 10000 });
  assert.ok(missed.mean < result.mean); assert.ok(missed.variance > 0);
});

test('Prepared context matches full growth computation under buffs and inheritance', () => {
  const team = [aru, hm], prepared = prepareTeam(team, data);
  const records = [{ skillId: `${hm.student.Id}:Ex`, enabled: true, targetId: aru.student.Id, time: 10, order: 1 }];
  for (const time of [0, 11, 30]) {
    const a = teamContext(team, aru.student.Id, records, { ...enemy, time, attackBuff: 25 }, data);
    const b = teamContext(team, aru.student.Id, records, { ...enemy, time, attackBuff: 25 }, data, true, prepared);
    assert.deepEqual(b.calculatedStudent.stats, a.calculatedStudent.stats);
  }
});

test('Cost regenerates from all team members, caps at ten, and scheduled EX spends exactly its cost', () => {
  const team = [aru, hm];
  const r = simulateTactic({ members: team, data, phases, duration: 40, mode: 'timeline', repeat: false,
    sequence: [{ studentId: aru.student.Id, key: 'Ex', earliest: 30, delay: 0 }] });
  const p = r.paths[0], action = p.events.find(e => e.actionId === '0-0' && e.type === 'cast');
  // Himari's permanent sub is 20.29% cost regeneration at level 10.
  const rate = (700 * 1.2029 * 2) / 10000;
  assert.ok(Math.abs(pointAt(p, 10).cost - rate * 10) < .001);
  assert.equal(action.time, 30); assert.equal(action.spent, 4);
  assert.ok(Math.abs(action.beforeCost - rate * 30) < .001);
  assert.ok(Math.abs(action.cost - (rate * 30 - 4)) < .001);
  const cap = simulateTactic({ members: team, data, phases, duration: 10, initialCost: 10, sequence: [] });
  assert.equal(pointAt(cap.paths[0], 10).cost, 10);
});

test('A scheduled action with insufficient cost is excluded rather than inventing damage or delaying silently', () => {
  const r = simulateTactic({ members: [aru], data, phases, duration: 5, mode: 'timeline', repeat: false,
    sequence: [{ studentId: aru.student.Id, key: 'Ex', earliest: 0 }] });
  assert.equal(r.paths[0].events.find(e => e.actionId === '0-0').type, 'blocked');
  assert.equal(r.paths[0].events.filter(e => e.type === 'damage' && e.actionId === '0-0').length, 0);
  assert.ok(r.warnings.some(w => w.includes('코스트 부족')));
});

test('Placement validation returns a usable cost-recovery time for the editor to snap to', () => {
  const action = { studentId: aru.student.Id, key: 'Ex', earliest: 0 };
  const input = { members: [aru], data, phases, duration: 70, mode: 'timeline', repeat: false, caseKeys: ['mean'] };
  const invalid = simulateTactic({ ...input, sequence: [action] });
  const slot = invalid.paths[0].events.find(e => e.type === 'blocked').nextAvailable;
  assert.equal(slot, 57.2);
  const valid = simulateTactic({ ...input, sequence: [{ ...action, earliest: slot }] });
  assert.equal(valid.paths[0].events.some(e => e.type === 'blocked'), false);
  assert.equal(valid.paths[0].events.find(e => e.actionId === '0-0').time, slot);
});

test('Buff before EX increases timeline damage; application delay and expiration are honored', () => {
  const run = active => simulateTactic({ members: [aru, hm], data, phases, initialCost: 10, duration: 20, mode: 'timeline', repeat: false,
    sequence: [...(active ? [{ studentId: hm.student.Id, key: 'Ex', earliest: 1, targetId: aru.student.Id }] : []),
      { studentId: aru.student.Id, key: 'Ex', earliest: 5, delay: 0 }] });
  const plain = run(false), buffed = run(true);
  const hit = r => r.paths[0].events.find(e => e.type === 'damage' && e.studentId === aru.student.Id && e.actionId !== undefined).damage;
  assert.ok(hit(buffed) > hit(plain));
  const records = buffed.paths[0].records;
  assert.ok(!teamContext([aru, hm], aru.student.Id, records, { ...enemy, time: 1.9 }, data).activeBuffs.some(b => b.type === 'Ex'));
  assert.ok(teamContext([aru, hm], aru.student.Id, records, { ...enemy, time: 2 }, data).activeBuffs.some(b => b.type === 'Ex'));
  assert.ok(!teamContext([aru, hm], aru.student.Id, records, { ...enemy, time: 15 }, data).activeBuffs.some(b => b.type === 'Ex'));
});

test('Real Binah phase HP and shared Kaiten HP are not summed as independent minions', () => {
  const binah = raids.raids.find(r => r.PathName === 'binah');
  const e = raidEnemy(raids, binah, 5, binah.EnemyList[5][0], 'Outdoor');
  const p = phaseProfile(raids, binah, 5, e, 'Outdoor');
  assert.deepEqual(p.map(p => p.hp), [3080000, 2695000, 1925000]);
  const kaiten = raids.raids.find(r => r.PathName === 'kaiten');
  const k = phaseProfile(raids, kaiten, 5, raidEnemy(raids, kaiten, 5, kaiten.EnemyList[5][0], 'Outdoor'), 'Outdoor');
  assert.deepEqual(k.map(p => p.hp), [6000000, 10000000]);
});

test('Phase transitions carry same-entity damage and respect configured attack pause', () => {
  const tiny = [{ name: '1', hp: 1, enemy, wait: 5, carry: true }, { name: '2', hp: 100, enemy, wait: 0 }];
  const r = simulateTactic({ members: [aru], data, phases: tiny, duration: 20, sequence: [] });
  for (const p of r.paths) assert.ok(p.completions[1].time - p.completions[0].time >= 5);
  const instant = simulateTactic({ members: [aru], data, phases: tiny.map(p => ({ ...p, wait: 0 })), duration: 20, sequence: [] });
  assert.equal(instant.paths[0].completions[1].time, instant.paths[0].completions[0].time);
});

test('All three paths are reproducible, bounded by phase HP, and show distinct damage without random samples', () => {
  const input = { members: [aru, hm], data, phases, duration: 30, sequence: [] };
  const a = simulateTactic(input), b = simulateTactic(input);
  assert.deepEqual(a.paths, b.paths);
  assert.ok(a.paths[0].damage <= a.paths[1].damage); assert.ok(a.paths[1].damage <= a.paths[2].damage);
  assert.ok(a.paths.every(p => p.damage <= a.totalHP && p.clearTime === null));
  const timing = normalTiming(aru.student);
  assert.equal(timing.rounds, 5); assert.equal(timing.reload, 70 / 30);
});
