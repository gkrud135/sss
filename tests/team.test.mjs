import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultBuild, combatResult, studentStats } from '../calc.mjs';
import { raidEnemy, resolveBuffs, supportBonuses, teamContext } from '../team.mjs';

const data = JSON.parse(await readFile(new URL('../data/global.json', import.meta.url), 'utf8'));
const raids = JSON.parse(await readFile(new URL('../data/raids.json', import.meta.url), 'utf8'));
const member = name => {
  const student = data.students.find(s => s.Name === name);
  return { student, build: { ...defaultBuild(student, data.meta.region), skills: { Ex: 5, Public: 10, Passive: 10, ExtraPassive: 10, Normal: 1 } } };
};
const aru = member('아루'), himari = member('히마리'), kotama = member('코타마'), ako = member('아코');
const raid = raids.raids.find(r => r.Name === '비나');
const enemy = { ...raidEnemy(raids, raid, 5, raid.EnemyList[5][0], 'Outdoor'), attackBuff: 0, critBuff: 0, defDown: 0,
  effectiveBuff: 0, exBuff: 0, damageBuff: 0, penetration: 0, currentTargetId: aru.student.Id, skillType: 'Ex' };
const activation = (m, key, order, extra = {}) => [ `${m.student.Id}:${key}`, { enabled: true, targetId: aru.student.Id, order, ...extra } ];

test('Same slot and channel overwrite by use order; different slots add', () => {
  const rows = [
    { id: 'strong', side: 'Ally', type: 'Ex', channel: 102, stat: 'AttackPower_Coefficient', amount: 10503, order: 1, label: 'strong' },
    { id: 'weak', side: 'Ally', type: 'Ex', channel: 102, stat: 'AttackPower_Coefficient', amount: 4744, order: 2, label: 'weak' },
    { id: 'sub', side: 'Ally', type: 'ExtraPassive', channel: 302, stat: 'AttackPower_Coefficient', amount: 1732, order: 0, label: 'sub' }
  ];
  const resolved = resolveBuffs(rows);
  assert.equal(resolved.bonuses.reduce((sum, b) => sum + b.amount, 0), 6476);
  assert.deepEqual(resolved.statuses.get('strong'), { status: 'overwritten', by: 'weak' });
});

test('An overwritten buff does not return when its replacement expires', () => {
  const rows = [{ id: 'old', side: 'Ally', type: 'Ex', channel: 102, stat: 'AttackPower_Coefficient', amount: 1000, order: 1, start: 0, end: 30 },
    { id: 'new', side: 'Ally', type: 'Ex', channel: 102, stat: 'AttackPower_Coefficient', amount: 2000, order: 2, start: 10, end: 15 }];
  assert.equal(resolveBuffs(rows, 5).bonuses[0].amount, 1000);
  assert.equal(resolveBuffs(rows, 12).bonuses[0].amount, 2000);
  assert.equal(resolveBuffs(rows, 20).bonuses.length, 0);
});

test('Support inheritance uses equipment and growth, and excludes enhanced skill', () => {
  const inherited = supportBonuses([aru, himari], aru.student, data);
  const plain = studentStats(himari.student, { ...himari.build, passive: false }, data).stats;
  assert.equal(inherited.find(b => b.stat === 'AttackPower_Base').amount, Math.floor(plain.AttackPower * 0.1));
  assert.equal(inherited.find(b => b.stat === 'HealPower_Base').amount, Math.floor(plain.HealPower * 0.05));
  assert.deepEqual(supportBonuses([aru, himari], himari.student, data), []);
});

test('Himari / Kotama conflict, Ako crit buffs and support inheritance affect actual damage', () => {
  const team = [aru, himari, kotama, ako];
  const empty = teamContext(team, aru.student.Id, {}, enemy, data);
  const active = Object.fromEntries([activation(himari, 'Ex', 1), activation(kotama, 'Ex', 2), activation(ako, 'Ex', 3), activation(ako, 'ExtraPassive', 0)]);
  const boosted = teamContext(team, aru.student.Id, active, enemy, data);
  assert.equal(boosted.statuses.get(`${himari.student.Id}:Ex:0`).status, 'overwritten');
  assert.ok(boosted.calculatedStudent.stats.CriticalPoint > empty.calculatedStudent.stats.CriticalPoint);
  assert.ok(boosted.calculatedStudent.stats.CriticalDamageRate > empty.calculatedStudent.stats.CriticalDamageRate);
  const skill = aru.student.Skills.Ex;
  assert.ok(combatResult(aru.student, aru.build, data, skill, skill.Effects[0], 5, boosted.enemy).expected >
    combatResult(aru.student, aru.build, data, skill, skill.Effects[0], 5, empty.enemy).expected);
});

test('EX and basic defense debuffs stack; armor restrictions remain enforced', () => {
  const akane = member('아카네'), maki = member('마키'), nagisa = member('나기사');
  const team = [aru, akane, maki, nagisa];
  const active = Object.fromEntries([activation(akane, 'Ex', 1), activation(maki, 'Public', 2), activation(nagisa, 'Ex', 3)]);
  const context = teamContext(team, aru.student.Id, active, enemy, data);
  assert.equal(context.enemyBonuses.filter(b => b.stat === 'DefensePower_Coefficient').length, 2);
  assert.equal(context.statuses.get(`${nagisa.student.Id}:Ex:1`).reason, '대상 조건 불일치');
  const skill = aru.student.Skills.Ex;
  assert.equal(combatResult(aru.student, aru.build, data, skill, skill.Effects[0], 5, context.enemy).defense, 1368);
});

test('Timed buffs respect application frame and exact duration boundary', () => {
  const records = [{ ...activation(himari, 'Ex', 1)[1], skillId: `${himari.student.Id}:Ex`, eventId: 'cast', time: 5 }];
  assert.equal(teamContext([aru, himari], aru.student.Id, records, { ...enemy, time: 5.9 }, data).studentBonuses.some(b => b.channel === 102), false);
  assert.equal(teamContext([aru, himari], aru.student.Id, records, { ...enemy, time: 6 }, data).studentBonuses.some(b => b.channel === 102), true);
  assert.equal(teamContext([aru, himari], aru.student.Id, records, { ...enemy, time: 19 }, data).studentBonuses.some(b => b.channel === 102), false);
});

test('Real raid values are loaded without the single-target demonstration defaults', () => {
  assert.equal(enemy.hp, 7700000);
  assert.equal(enemy.defense, 5000);
  assert.equal(enemy.level, 80);
  assert.equal(enemy.critResist, 20);
  assert.equal(enemy.critDmgResist, 80);
  assert.equal(enemy.evasion, 100);
  for (const r of raids.raids) for (let difficulty = 0; difficulty <= r.MaxDifficulty; difficulty++) for (const id of r.EnemyList[difficulty]) {
    const e = raidEnemy(raids, r, difficulty, id, r.Terrain[0]);
    assert.ok(Number.isFinite(e.hp) && e.hp > 0);
    assert.ok(Number.isFinite(e.defense) && e.defense >= 0);
  }
});
