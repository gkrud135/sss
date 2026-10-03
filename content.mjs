import { skillDescription } from './calc.mjs';

export const DRILL_NAMES = { Shooting: '사격 시험', Defense: '방어 시험', Destruction: '돌파 시험', Escort: '호위 시험' };

export const SKILL_FILTERS = {
  attack: '공격력 증가', defense: '방어력 감소', critical: '치명 버프', speed: '공격속도 증가',
  costRegen: '코스트 회복', cost: 'EX 코스트 감소', heal: '회복', shield: '보호막',
  control: '군중 제어', dispel: '효과 해제', damage: '직접 피해'
};
const normalizeQuery = text => String(text ?? '').toLocaleLowerCase().replace(/\s/g, '');
function skillEffectMatches(effect, filter) {
  const amounts = (effect.Value ?? effect.Scale ?? []).flat();
  const buff = (stat, sign) => effect.Type === 'Buff' && effect.Stat?.startsWith(stat + '_') && amounts.some(n => sign * n > 0);
  switch (filter) {
    case 'attack': return buff('AttackPower', 1);
    case 'defense': return buff('DefensePower', -1);
    case 'critical': return buff('CriticalPoint', 1) || buff('CriticalDamageRate', 1);
    case 'speed': return buff('AttackSpeed', 1);
    case 'costRegen': return buff('RegenCost', 1);
    case 'cost': return effect.Type === 'CostChange' && amounts.some(n => n < 0);
    case 'heal': return ['Heal', 'Regen'].includes(effect.Type);
    case 'shield': return effect.Type === 'Shield';
    case 'control': return effect.Type === 'CrowdControl';
    case 'dispel': return effect.Type === 'Dispel';
    case 'damage': return effect.Type === 'Damage';
    default: return true;
  }
}

// Search source skills, including equipment upgrades, without changing student builds.
export function matchingSkills(student, labels, { query = '', effect = '', slot = '', target = '' } = {}) {
  const words = query.trim().split(/\s+/).filter(Boolean).map(normalizeQuery), matches = [];
  for (const [source, main] of Object.entries(student.Skills)) {
    if (source === 'Normal') continue;
    const type = source === 'GearPublic' ? 'Public' : source === 'WeaponPassive' ? 'Passive' : source;
    if (slot && slot !== type) continue;
    for (const [i, skill] of [main, ...(main.ExtraSkills ?? [])].entries()) {
      if (words.length && !words.every(word => normalizeQuery(`${skill.Name} ${skillDescription(skill, 1, labels)}`).includes(word))) continue;
      if ((effect || target) && !(skill.Effects ?? []).some(e => skillEffectMatches(e, effect) &&
        (!target || (Array.isArray(e.Target) ? e.Target : [e.Target]).some(t => target === 'self' ? t === 'Self' : target === 'enemy' ? /^Enemy/.test(t) : /^Ally/.test(t))))) continue;
      matches.push({ skill, type, source, key: i ? `${type}:${i - 1}` : type });
    }
  }
  return matches;
}

export function rosterStudents(students, filter = 'all') {
  return students.filter(s => filter === 'global' ? s.IsReleased?.[1] !== false : filter === 'japan-only' ? s.IsReleased?.[0] && !s.IsReleased?.[1] : true);
}

export function serverRaids(raids, server = 1, mode = 'raid') {
  return raids.filter(r => r.IsReleased?.[server] !== false).map(r => ({ ...r,
    MaxDifficulty: r.MaxDifficultyByServer?.[server] ?? r.MaxDifficulty,
    EliminateVariants: server === 0 ? r.JapanEliminateVariants ?? [] : r.EliminateVariants
  })).filter(r => mode !== 'eliminate' || r.EliminateVariants.length);
}

// A drill adapter reuses enemy-stat and tactic calculations for one selected target.
// Formation lists describe enemy types, not their spawn counts or wave order.
export function drillRaid(drill, server = 1) {
  return { ...drill, Id: `drill:${drill.Id}`, ContentType: 'drill', PathName: 'drill',
    Name: `${drill.Id}회차 · ${DRILL_NAMES[drill.DungeonType]}`,
    MaxDifficulty: drill.MaxDifficulty[server], Levels: drill.Level,
    EnemyList: drill.Formations.map(f => f.EnemyList), RaidSkillList: drill.Formations.map(() => []) };
}

export function drillRules(raidData, drill, difficulty) {
  return (drill.Rules[difficulty] ?? []).map(row => ({ ...raidData.drillRules[String(row.Id)],
    Parameters: row.Parameters ?? raidData.drillRules[String(row.Id)]?.Parameters }));
}
