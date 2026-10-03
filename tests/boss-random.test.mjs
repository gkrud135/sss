import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBossPlan, randomTargets } from '../boss-random.mjs';

const raids = JSON.parse(await readFile(new URL('../data/raids.json', import.meta.url), 'utf8'));
const actor = raids.enemies['7300600'];
const input = { phases: [{ enemy: { character: actor } }], members: [{ student: { Id: 1, SquadType: 'Main' } },
  { student: { Id: 2, SquadType: 'Support' } }], raidData: raids, duration: 180, seed: 314, interval: 20 };

test('A fixed random example remains identical when EX cards are edited', () => {
  const a = randomBossPlan(input), b = randomBossPlan({ ...input, sequence: [{ earliest: 10 }] });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, randomBossPlan({ ...input, seed: 315 }));
  assert.ok(a.length > 5);
  for (const action of a) {
    assert.ok(actor.Skills.includes(action.skillId));
    assert.ok(action.time > 0 && action.time <= 180);
    assert.deepEqual(action.targetIds, [1]);
    assert.ok(action.targetRoll >= 0 && action.targetRoll < 1);
  }
});

test('Repeated HP phases of the same boss do not duplicate its random actions', () => {
  const single = randomBossPlan(input), repeated = randomBossPlan({ ...input, phases: [...input.phases, ...input.phases] });
  assert.deepEqual(single, repeated);
});

test('Random targeting uses distinct living strikers and respects source target counts', () => {
  const action={targetRoll:.35,targetCount:2};
  const targets=randomTargets(action,[1,3,4]);
  assert.equal(targets.length,2);assert.equal(new Set(targets).size,2);assert.equal(targets.includes(2),false);
  assert.deepEqual(randomTargets(action,[1]),[1]);
  assert.deepEqual(randomTargets({...action,targetCount:4},[1,3,4]).sort(),[1,3,4]);
});
