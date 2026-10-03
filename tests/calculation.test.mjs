import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combatResult, damageCap, defaultBuild, interpolate, normalizeBuild, sanitizeBuild, skillOptions, studentStats } from '../calc.mjs';

const data = JSON.parse(await readFile(new URL('../data/global.json', import.meta.url), 'utf8'));
const aru = data.students.find(s => s.Id === 10000);
const region = data.meta.region;
const build = { ...defaultBuild(aru, region), passive: false };
const enemy = { armor: 'LightArmor', terrain: 'Street', level: 90, defense: 0, attackBuff: 0, critBuff: 0,
  defDown: 0, penetration: 0, effectiveBuff: 0, exBuff: 0, critResist: 100, critDmgResist: 50,
  evasion: 0, damageBuff: 0, skillType: 'Ex', assumeCondition: false };
const effect = aru.Skills.Ex.Effects[0];
const result = (e = {}, b = build, fx = effect, skill = aru.Skills.Ex) => combatResult(aru, b, data, skill, fx, 1, { ...enemy, ...e });

test('Aru level 1 / 3 stars: independent star-growth fixtures', () => {
  const { stats } = studentStats(aru, { ...build, level: 1 }, data);
  assert.equal(stats.AttackPower, 451); // ceil(369 × 1.22)
  assert.equal(stats.MaxHP, 2505); // ceil(2236 × 1.12)
  assert.equal(stats.DefensePower, 19);
  assert.equal(stats.HealPower, 1655); // ceil(1408 × 1.175)
  assert.equal(interpolate(369, 3690, 100), 3690);
});

test('Defense 1666.666... halves ordinary damage; level difference floors at 40%', () => {
  const baseline = result();
  const defended = result({ defense: 10000 / 6 });
  assert.ok(Math.abs(defended.defenseMod - 0.5) < 1e-12);
  assert.ok(Math.abs(defended.nonCrit.max * 2 - baseline.nonCrit.max) <= 1);
  assert.equal(result({ level: 100 }, { ...build, level: 1 }).levelMod, 0.4);
  assert.equal(result({ level: 1 }).levelMod, 1);
});

test('Type effectiveness and terrain follow source table', () => {
  assert.equal(result().effectiveness, 2);
  assert.equal(result({ armor: 'Unarmed' }).effectiveness, 0.5);
  assert.ok(Math.abs(result({ terrain: 'Indoor' }).terrainMod - 0.8) < 1e-12);
  assert.ok(Math.abs(result({ terrain: 'Street' }).terrainMod - 1.2) < 1e-12);
  assert.equal(result({ armor: 'HeavyArmor', effectiveBuff: 100 }).effectiveness, 1);
  assert.equal(result({ effectiveBuff: 100 }).effectiveness, 3);
});

test('Guaranteed/never critical and evasion affect expected value', () => {
  const always = result({}, build, { ...effect, CriticalCheck: 'Always' });
  assert.equal(always.critRate, 1);
  assert.equal(always.expected, always.crit.avg);
  const never = result({}, build, { ...effect, CriticalCheck: 'Never' });
  assert.equal(never.expected, never.nonCrit.avg);
  const evade = result({ evasion: 3000 });
  assert.ok(evade.accuracy < 1);
  assert.ok(evade.expected < result().expected);
});

test('Buffs, defense reduction and penetration behave independently', () => {
  assert.ok(result({ attackBuff: 100 }).nonCrit.max > result().nonCrit.max * 1.99);
  assert.ok(result({ defense: 1000, defDown: 50 }).nonCrit.max > result({ defense: 1000 }).nonCrit.max);
  assert.equal(result({ defense: 1000, penetration: 1000 }).defenseMod, 1);
  const ignore = result({ defense: 1000 }, build, { ...effect, IgnoreDef: [0] });
  assert.equal(ignore.defenseMod, 1);
});

test('Soft cap is applied per hit rather than to the sum', () => {
  assert.equal(damageCap(4000000), 4000000);
  assert.equal(damageCap(5000000), 4800000);
  assert.equal(damageCap(100000000), 10969999);
  const fx = { ...effect, Scale: [100000000], Hits: [10000, 10000] };
  assert.equal(result({}, build, fx).nonCrit.max, 21939998);
});

test('Unavailable weapon, equipment, gear, bond and potential are gated', () => {
  const b = normalizeBuild(aru, { ...build, level: 1, stars: 3, bond: 50, gear: 2, weaponStars: 4,
    weaponLevel: 60, equipment: [10, 10, 10], potential: 25 }, region);
  assert.equal(b.weaponStars, 0);
  assert.equal(b.bond, 20);
  assert.deepEqual(b.equipment, [10, 0, 0]);
  assert.equal(b.potential, 0);
  assert.equal(normalizeBuild(aru, { ...build, bond: 1, gear: 2 }, region).gear, 0);
  assert.equal(normalizeBuild(aru, { ...build, bond: 15, gear: 2 }, region).gear, 1);
  const weapon = normalizeBuild(aru, { ...build, stars: 5, weaponStars: 1, weaponLevel: 60 }, region);
  assert.equal(weapon.weaponLevel, 30);
});

test('Gear T2 activates upgraded normal skill; weapon passive is additive', () => {
  assert.equal(skillOptions(aru, { ...build, gear: 2 }).find(s => s.key === 'Public').type, 'GearPublic');
  const b = { ...build, stars: 5, passive: true, weaponStars: 2, weaponLevel: 40 };
  const stats = studentStats(aru, b, data).stats;
  assert.equal(stats.CriticalDamageRate, 25080); // (20000 + 2000) × 1.14
});

test('Special/conditional effects are never silently approximated', () => {
  assert.equal(result({}, build, { ...effect, MultiplySource: 'InvokerCurrentHP' }).supported, false);
  assert.equal(result({}, build, { ...effect, TargetHpRateModifier: {} }).supported, false);
  assert.equal(result({}, build, { ...effect, Condition: { Type: 'Special' } }).supported, false);
  assert.equal(result({ assumeCondition: true }, build, { ...effect, Condition: { Type: 'Special' } }).supported, true);
});

test('Level and star comparisons preserve inputs and restore their original calculated stats', () => {
  const requested = { ...build, stars: 5, bond: 50, equipment: [10, 10, 10], weaponStars: 4,
    weaponLevel: 60, gear: 2, potential: 25 };
  const high = studentStats(aru, requested, data).stats;
  const lowRequest = sanitizeBuild(aru, { ...requested, level: 1, stars: 3 }, region);
  assert.deepEqual(lowRequest.equipment, requested.equipment);
  assert.equal(lowRequest.potential, 25);
  assert.equal(lowRequest.weaponStars, 4);
  const low = studentStats(aru, lowRequest, data);
  assert.deepEqual(low.build.equipment, [10, 0, 0]);
  assert.equal(low.build.potential, 0);
  assert.equal(low.build.weaponStars, 0);
  const restored = sanitizeBuild(aru, { ...lowRequest, level: 90, stars: 5 }, region);
  assert.deepEqual(studentStats(aru, restored, data).stats, high);
});

test('All global students produce finite stats at level boundaries; direct damage effects remain finite', () => {
  let checked = 0;
  assert.equal(data.students.length, data.meta.count);
  assert.equal(new Set(data.students.map(s => s.Id)).size, data.students.length);
  for (const student of data.students) {
    for (const level of [1, 15, 35, region.StudentMaxLevel]) {
      const b = { ...defaultBuild(student, region), level };
      const { stats } = studentStats(student, b, data);
      assert.ok(Object.values(stats).every(n => Number.isFinite(n) && n >= 0), student.Name);
      assert.ok(stats.MaxHP > 0, student.Name);
    }
    const b = defaultBuild(student, region);
    for (const entry of skillOptions(student, b)) {
      for (const fx of entry.skill.Effects ?? []) {
        if (fx.Type !== 'Damage') continue;
        const r = combatResult(student, b, data, entry.skill, fx, 1, { ...enemy, skillType: entry.type });
        if (!r.supported) continue;
        assert.ok(Number.isFinite(r.expected) && r.expected >= 0, `${student.Name} / ${entry.type}`);
        assert.ok(r.nonCrit.min <= r.nonCrit.max);
        checked++;
      }
    }
  }
  assert.ok(checked > 400, `Supported effects: ${checked}`);
});
