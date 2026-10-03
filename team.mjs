import { applyStudentBonuses, atLevel, combatResult, growthRegion, interpolate, modifiedStat, normalizeBuild, skillOptions, studentStats } from './calc.mjs';

export const DIFFICULTIES = ['NORMAL', 'HARD', 'VERY HARD', 'HARDCORE', 'EXTREME', 'INSANE', 'TORMENT', 'LUNATIC'];
const studentStatsUsed = new Set(['MaxHP', 'AttackPower', 'DefensePower', 'HealPower', 'AccuracyPoint', 'DodgePoint',
  'CriticalPoint', 'CriticalDamageRate', 'CriticalChanceRate', 'StabilityPoint', 'StabilityRate', 'DefensePenetration',
  'EnhanceExDamageRate', 'EnhanceBasicsDamageRate', 'EnhanceExplosionRate', 'EnhancePierceRate', 'EnhanceMysticRate',
  'EnhanceSonicRate', 'DamageRatio', 'DamageRatio2', 'RegenCost', 'ExtendBuffDuration', 'AttackSpeed',
  'CriticalChanceResistPoint', 'CriticalDamageResistRate', 'HealEffectivenessRate']);
const enemyStatsUsed = new Set(['AttackPower', 'AccuracyPoint', 'CriticalPoint', 'DefensePower', 'DodgePoint', 'CriticalChanceResistPoint', 'CriticalDamageResistRate',
  'DamagedRatio', 'DamagedRatio2', 'ExDamagedRatio', 'ReduceWeakDamagedRate', 'WeakDamagedRatio',
  'EffectiveDamagedRatio', 'NormalDamagedRatio', 'ResistDamagedRatio']);

export function teamSkills(student, build, region) {
  return skillOptions(student, normalizeBuild(student, build, region))
    .filter(entry => !['Passive', 'Normal'].includes(entry.key) && entry.skill.Effects?.some(e => e.Type === 'Buff'))
    .map(entry => ({ ...entry, id: `${student.Id}:${entry.key}`, level: build.skills[entry.parent ?? entry.key] ?? 1 }));
}

export function buffIssues(effect, side) {
  const reasons = [];
  const [stat, kind] = (effect.Stat ?? '').split('_');
  if (!(side === 'Enemy' ? enemyStatsUsed : studentStatsUsed).has(stat)) reasons.push('1회 피해량에 반영하지 않는 능력치');
  if (!['Base', 'Coefficient', 'BaseOuter'].includes(kind)) reasons.push('특수 능력치 방식');
  if (!Array.isArray(effect.Value) || !effect.Value.length) reasons.push('효과 수치 없음');
  if (!Number.isFinite(effect.Channel)) reasons.push('중첩 구분 데이터 없음');
  for (const field of ['MultiplySource', 'StatModifier', 'SubstituteValue', 'ValueSource']) if (effect[field] !== undefined) reasons.push('조건별 수치 계산 필요');
  return reasons;
}

function restrictionMatches(restriction, target) {
  const value = target[restriction.Property];
  if (value === undefined) return null;
  if (restriction.Operand === 'Equal') return value === restriction.Value;
  if (restriction.Operand === 'NotEqual') return value !== restriction.Value;
  if (restriction.Operand === 'Contains') return Array.isArray(value) && value.includes(restriction.Value);
  return null;
}

function conditionMatches(condition, target, assumed) {
  if (!condition) return true;
  if (condition.Type === 'TargetProp') return restrictionMatches({ Property: condition.Parameter, ...condition }, target);
  return assumed ? true : null;
}

export function resolveBuffs(rows, now = Infinity) {
  const winners = new Map();
  const statuses = new Map();
  for (const row of [...rows].sort((a, b) => a.order - b.order)) {
    if (row.start !== undefined && row.start > now) continue;
    const key = `${row.side}:${row.type}:${row.channel}:${row.stat.split('_')[0]}`;
    const previous = winners.get(key);
    if (previous) statuses.set(previous.id, { status: 'overwritten', by: row.label });
    winners.set(key, row);
    statuses.set(row.id, { status: 'applied' });
  }
  for (const row of winners.values()) if (row.end !== undefined && now >= row.end) statuses.set(row.id, { status: 'expired', reason: '지속 시간 만료' });
  return { bonuses: [...winners.values()].filter(row => row.end === undefined || now < row.end), statuses };
}

// Support inheritance excludes skill buffs, including the support's enhanced skill.
export function supportBonuses(members, target, data) {
  if (target.SquadType !== 'Main') return [];
  const bonuses = [];
  for (const member of members.filter(m => m.student.SquadType === 'Support')) {
    const stats = studentStats(member.student, { ...member.build, passive: false }, data).stats;
    for (const [stat, rate] of Object.entries({ MaxHP: 0.1, AttackPower: 0.1, DefensePower: 0.05, HealPower: 0.05 }))
      bonuses.push({ stat: `${stat}_Base`, amount: Math.floor(stats[stat] * rate), label: `${member.student.Name} 지원` });
  }
  return bonuses;
}

export function prepareTeam(members, data) {
  const prepared = new Map();
  const support = members.filter(m => m.student.SquadType === 'Support').map(member => {
    const stats = studentStats(member.student, { ...member.build, passive: false }, data).stats;
    return Object.entries({ MaxHP: .1, AttackPower: .1, DefensePower: .05, HealPower: .05 }).map(([stat, rate]) =>
      ({ stat: `${stat}_Base`, amount: Math.floor(stats[stat] * rate), label: `${member.student.Name} 지원` }));
  }).flat();
  for (const member of members) prepared.set(member.student.Id, {
    member, build: normalizeBuild(member.student, member.build, growthRegion(member.student, data)),
    calculated: studentStats(member.student, { ...member.build, passive: false }, data),
    skills: teamSkills(member.student, member.build, growthRegion(member.student, data)),
    inheritance: member.student.SquadType === 'Main' ? support : []
  });
  return prepared;
}

export function teamContext(members, targetId, activations, enemy, data, withSkills = true, prepared = null) {
  const targetMember = members.find(m => m.student.Id === targetId);
  if (!targetMember) return null;
  const target = targetMember.student;
  const enemyTarget = { ...(enemy.character ?? {}), ArmorType: enemy.armor };
  const rows = [], statuses = new Map();
  const addEffect = (source, entry, effect, index, activation, automatic = false) => {
    if (enemy.time >= activation.endedAt) return;
    if (activation.effectIndexes && !activation.effectIndexes.includes(index)) return;
    const id = `${activation.eventId ?? entry.id}:${index}`;
    const targets = Array.isArray(effect.Target) ? effect.Target : [effect.Target];
    const side = targets.includes('Enemy') ? 'Enemy' : 'Ally';
    if (side === 'Enemy' && (activation.ignoreEnemy || enemy.time >= activation.enemyClearedAt)) return;
    const isSelf = source.Id === targetId;
    const eligible = side === 'Enemy' || (isSelf ? targets.includes('Self') : targets.includes(target.SquadType === 'Main' ? 'AllyMain' : 'AllySupport'));
    const singleAlly = side === 'Ally' && !targets.includes('Self') && targets.length === 1 && !entry.skill.Radius && entry.type !== 'ExtraPassive';
    const targetMatches = !singleAlly || activation.targetId === targetId || activation.targetId === 'current' && enemy.currentTargetId === targetId;
    if (!eligible || !targetMatches) { statuses.set(id, { status: 'target', reason: '다른 대상' }); return; }
    const actualTarget = side === 'Enemy' ? enemyTarget : target;
    for (const restriction of effect.Restrictions ?? []) {
      const matches = restrictionMatches(restriction, actualTarget);
      if (matches !== true) { statuses.set(id, { status: 'excluded', reason: matches === false ? '대상 조건 불일치' : '대상 조건 확인 필요' }); return; }
    }
    const condition = conditionMatches(effect.Condition ?? entry.skill.Condition, actualTarget, activation.assumeCondition);
    if (condition !== true) { statuses.set(id, { status: 'excluded', reason: condition === false ? '발동 조건 불일치' : '조건 충족 체크 필요' }); return; }
    const issues = buffIssues(effect, side);
    if (issues.length) { statuses.set(id, { status: 'unsupported', reason: issues.join(' · ') }); return; }
    const stacks = Math.max(1, Math.round(activation.stacks ?? 1));
    const valueRow = effect.Value[effect.StackSame ? 0 : Math.min(stacks, effect.Value.length) - 1];
    const amount = atLevel(valueRow, entry.level) * (effect.StackSame ? stacks : 1);
    const start = automatic ? undefined : activation.time === undefined ? undefined : activation.time + (effect.ApplyFrame ?? 0) / 30;
    if (start >= activation.interruptedAt) return;
    const duration = activation.buffDuration > 0 ? activation.buffDuration : effect.Duration ? effect.Duration / 1000 * (activation.durationMultiplier ?? 1) : Infinity;
    rows.push({ id, side, stat: effect.Stat, amount, channel: effect.Channel, start, end: start === undefined ? undefined : start + duration,
      type: effect.OverrideSlot ?? ({ GearPublic: 'Public', WeaponPassive: 'Passive' }[entry.type] ?? entry.type),
      order: automatic ? -1000 : activation.order, label: `${source.Name} · ${entry.skill.Name ?? entry.type}` });
  };
  const ready = prepared?.get(targetId);
  const b = ready?.build ?? normalizeBuild(target, targetMember.build, growthRegion(target, data));
  if (b.passive) for (const [type, skill] of [['Passive', target.Skills.Passive], ['WeaponPassive', b.weaponStars >= 2 ? target.Skills.WeaponPassive : null]]) {
    if (!skill) continue;
    const entry = { id: `${target.Id}:${type}`, type, skill, level: b.skills.Passive };
    (skill.Effects ?? []).forEach((effect, i) => {
      if (effect.Type === 'Buff' && effect.Target?.includes('Self') && !effect.Duration && !effect.Condition && effect.Value?.length === 1 && !effect.StackSame)
        addEffect(target, entry, effect, i, { stacks: 1 }, true);
    });
  }
  if (withSkills) for (const member of members) for (const entry of prepared?.get(member.student.Id)?.skills ?? teamSkills(member.student, member.build, growthRegion(member.student, data))) {
    const matching = Array.isArray(activations) ? activations.filter(a => a.skillId === entry.id) : [activations[entry.id]];
    for (const activation of matching) {
      if (!activation?.enabled) continue;
      (entry.skill.Effects ?? []).forEach((effect, i) => { if (effect.Type === 'Buff') addEffect(member.student, entry, effect, i, activation); });
    }
  }
  const resolved = resolveBuffs(rows, enemy.time ?? Infinity);
  for (const [id, status] of resolved.statuses) statuses.set(id, status);
  const inheritance = ready?.inheritance ?? supportBonuses(members, target, data);
  const studentBonuses = [...inheritance, ...resolved.bonuses.filter(r => r.side === 'Ally')];
  const enemyBonuses = resolved.bonuses.filter(r => r.side === 'Enemy');
  const calculatedStudent = ready ? applyStudentBonuses(ready.calculated, studentBonuses, data, enemy.attackBuff, enemy.critBuff)
    : studentStats(target, { ...targetMember.build, passive: false }, data, enemy.attackBuff, enemy.critBuff, studentBonuses);
  return { studentBonuses, enemyBonuses, calculatedStudent, statuses, inheritance,
    nextBoundary: Math.min(Infinity, ...rows.flatMap(r => [r.start, r.end]).filter(t => t > (enemy.time ?? Infinity))),
    activeBuffs: resolved.bonuses,
    enemy: { ...enemy, studentBonuses, enemyBonuses, calculatedStudent } };
}

export function damageChoices(student, build, region) {
  const choices = [];
  for (const entry of skillOptions(student, normalizeBuild(student, build, region)))
    (entry.skill.Effects ?? []).forEach((effect, i) => { if (effect.Type === 'Damage') choices.push({ value: `${entry.key}|${i}`, entry, effect, index: i }); });
  return choices;
}

export function teamDamage(member, choice, context, data) {
  if (!choice || !context) return { supported: false, reasons: ['직접 피해 스킬 없음'] };
  const level = member.build.skills[choice.entry.parent ?? choice.entry.key] ?? 1;
  return combatResult(member.student, member.build, data, choice.entry.skill, choice.effect, level,
    { ...context.enemy, skillType: choice.entry.type, assumeCondition: false });
}

export function raidEnemy(raidData, raid, difficulty, enemyId, terrain, armor) {
  const character = raidData.enemies[String(enemyId)];
  if (!character || !raid.EnemyList[difficulty]?.includes(Number(enemyId))) throw new Error('해당 난이도의 적 데이터가 없습니다.');
  const level = raid.Levels[difficulty];
  const limits = raidData.limits[character.Rank] ?? {};
  const additions = (raid.ExtraStats[String(enemyId)] ?? []).filter(e => !e.LabelStacks && (!e.Difficulty || difficulty >= e.Difficulty[0] && difficulty <= e.Difficulty[1])).map(e => ({ stat: e.Stat, amount: e.Amount }));
  const stat = name => modifiedStat(interpolate(character[`${name}1`], character[`${name}100`], level), name, additions, limits);
  const result = { character, limits, armor: armor ?? character.ArmorType, terrain, level, defense: stat('DefensePower'), hp: stat('MaxHP'),
    critResist: character.CriticalChanceResistPoint ?? character.CriticalResistPoint ?? 100,
    critDmgResist: (character.CriticalDamageResistRate ?? 5000) / 100, evasion: character.DodgePoint ?? 0 };
  for (const name of enemyStatsUsed) if (name.endsWith('Ratio') || name.endsWith('Ratio2') || name === 'ReduceWeakDamagedRate') result[name] = character[name] ?? 10000;
  return result;
}
