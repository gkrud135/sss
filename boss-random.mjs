import { enemyActions } from './battle.mjs';

// A repeatable example schedule, not an inferred game AI distribution.
export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let x = Math.imul(state ^ state >>> 15, 1 | state);
    x ^= x + Math.imul(x ^ x >>> 7, 61 | x);
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

export function randomBossPlan({ phases, members, raidData, duration, seed = 1, interval = 20 }) {
  const random = seededRandom(seed), actors = [...new Map(phases.filter(p => p.enemy.character)
    .map(p => [p.enemy.character.Id, p.enemy.character])).values()];
  const gap = Math.max(5, Number(interval) || 20), end = Math.min(600, Math.max(1, Number(duration) || 180));
  const targets = members.filter(m => m.student.SquadType === 'Main').map(m => m.student.Id);
  const plans = [];
  for (let time = gap * (.8 + random() * .4); time <= end; time += gap * (.8 + random() * .4)) {
    const at = Math.round(time * 10) / 10;
    for (const actor of actors) {
      const all = enemyActions(raidData, { character: actor });
      const special = all.filter(a => a.skill.Type !== 'Normal');
      const choices = special.length ? special : all;
      if (!choices.length) continue;
      const entry = choices[Math.floor(random() * choices.length)];
      const description = raidData.raidSkills[entry.key]?.Desc ?? entry.skill.Desc ?? '';
      const damageScale = description.match(/공격력\s*(\d+(?:\.\d+)?)%/)?.[1];
      const matched = entry.skill.Effects?.findIndex(e => e.Type === 'Damage' &&
        (Array.isArray(e.Scale?.[0]) ? e.Scale[0][0] : e.Scale?.[0]) === Number(damageScale) * 100) ?? -1;
      const effectIndex = matched >= 0 ? matched : Math.max(0, entry.skill.Effects?.findIndex(e => ['Damage', 'DamageDebuff', 'CrowdControl'].includes(e.Type)) ?? 0);
      const targetCount = /모든 적|적 전체|전체 적/.test(description) ? 4 : Number(description.match(/적\s*(\d+)인/)?.[1] ?? 1);
      const targetRoll = random();
      // Source target counts are honored; spatial shapes use one random target.
      plans.push({ enemyId: actor.Id, skillId: entry.key, effectIndex, time: at,
        delay: 0, repeat: false, interval: gap, targetIds: targets, targetRoll, targetCount,
        randomPattern: true, buffDuration: 30, phase: 0, damageMultiplier: 100,
        stateDuration: 0, bossReceived: 100 });
    }
  }
  return plans;
}

export function randomTargets(action, livingIds) {
  const ids = [...livingIds], random = seededRandom(Math.floor(action.targetRoll * 4294967296));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.max(1, action.targetCount || 1));
}
