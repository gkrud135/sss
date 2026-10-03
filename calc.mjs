// Formula references: Schale DB's current stat and calculator modules.
// Data scales use 10,000 = 100%. Conditional/timeline effects are never inferred.
export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : min));
export const atLevel = (values, level) => Array.isArray(values) ? values[Math.min(values.length - 1, Math.max(0, level - 1))] ?? 0 : values ?? 0;
export const SKILL_NAMES = { Normal: '일반 공격', Ex: 'EX 스킬', Public: '기본 스킬', GearPublic: '기본 스킬+', Passive: '강화 스킬', WeaponPassive: '강화 스킬+', ExtraPassive: '서브 스킬' };

export function growthRegion(student, data) {
  return student.IsReleased?.[1] === false && data.meta.japanRegion ? data.meta.japanRegion : data.meta.region;
}

export function interpolate(first, last, level, multiplier = 1) {
  const growth = Number(((level - 1) / 99).toFixed(4));
  return Math.ceil(Number((Math.round(Number((first + (last - first) * growth).toFixed(4))) * multiplier).toFixed(4)));
}

export function defaultBuild(student, region) {
  return { level: region.StudentMaxLevel, stars: student.StarGrade, bond: 1, weaponStars: 0, weaponLevel: 1,
    gear: 0, equipment: [0, 0, 0], passive: true, potential: 0,
    skills: { Normal: 1, Ex: 1, Public: 1, Passive: 1, ExtraPassive: 1 } };
}

// Requested inputs stay intact while calculations use only currently usable settings.
export function sanitizeBuild(student, build, region) {
  const b = { ...build, equipment: [...build.equipment], skills: { ...build.skills } };
  b.level = Math.round(clamp(b.level, 1, region.StudentMaxLevel));
  b.stars = Math.round(clamp(b.stars, student.StarGrade, 5));
  b.bond = Math.round(clamp(b.bond, 1, region.BondMaxLevel));
  b.weaponStars = Math.round(clamp(b.weaponStars, 0, region.WeaponMaxLevel / 10 - 2));
  b.weaponLevel = Math.round(clamp(b.weaponLevel, 1, region.WeaponMaxLevel));
  b.gear = student.Gear?.Released?.[region.Name === 'Jp' ? 0 : 1] ? Math.round(clamp(b.gear, 0, 2)) : 0;
  b.equipment = b.equipment.map((tier, i) => Math.round(clamp(tier, 0, region.EquipmentMaxLevel[i])));
  b.potential = Math.round(clamp(b.potential, 0, region.PotentialMax));
  for (const type in b.skills) b.skills[type] = Math.round(clamp(b.skills[type], 1, type === 'Ex' ? 5 : type === 'Normal' ? 1 : 10));
  return b;
}

export function normalizeBuild(student, build, region) {
  const b = sanitizeBuild(student, build, region);
  b.bond = Math.min(b.bond, [10, 10, 20, 20, 50][b.stars - 1]);
  b.weaponStars = b.stars === 5 ? b.weaponStars : 0;
  b.weaponLevel = Math.min(b.weaponLevel, b.weaponStars ? Math.min(region.WeaponMaxLevel, 20 + 10 * b.weaponStars) : 1);
  if (b.gear && b.bond < region.GearBondReq[b.gear - 1]) b.gear = b.bond >= region.GearBondReq[0] ? 1 : 0;
  b.equipment = b.equipment.map((tier, i) => b.level >= [1, 15, 35][i] ? tier : 0);
  b.potential = b.stars === 5 && b.level >= 90 ? b.potential : 0;
  return b;
}

export function modifiedStat(base, stat, bonuses = [], limits = {}) {
  const addition = { Base: 0, Coefficient: 0, BaseOuter: 0 };
  for (const bonus of bonuses) {
    const [name, kind] = bonus.stat.split('_');
    if (name === stat && kind in addition) addition[kind] += bonus.amount;
  }
  const limit = limits[stat];
  const unbounded = ['DamageRatio2', 'DamagedRatio2'].includes(stat);
  const rate = limit && !unbounded ? clamp(1 + addition.Coefficient / 10000, 1 + limit.RatioMin / 10000, 1 + limit.RatioMax / 10000) : 1 + addition.Coefficient / 10000;
  const total = Math.round(Number(((base + addition.Base) * rate).toFixed(4))) + addition.BaseOuter;
  return limit ? clamp(total, limit.Min, limit.Max) : Math.max(0, total);
}

export function studentStats(student, build, data, attackBuff = 0, critBuff = 0, bonuses = []) {
  const b = normalizeBuild(student, build, growthRegion(student, data));
  const stats = {};
  const notes = [];
  build.equipment.forEach((tier, i) => { if (tier && !b.equipment[i]) notes.push(`장비 ${i + 1} T${tier}: Lv.${[1, 15, 35][i]} 미만이므로 계산에서 제외합니다. 설정은 보관됩니다.`); });
  if (build.weaponStars && !b.weaponStars) notes.push('고유무기는 5성 미만이므로 계산에서 제외합니다. 설정은 보관됩니다.');
  if (b.weaponStars && build.weaponLevel > b.weaponLevel) notes.push(`고유무기 ${b.weaponStars}성의 상한 Lv.${b.weaponLevel}로 계산합니다.`);
  if (build.bond > b.bond) notes.push(`현재 성급의 인연 상한 ${b.bond}로 계산합니다.`);
  if (build.gear > b.gear) notes.push(`인연 조건에 따라 애용품은 ${b.gear ? `T${b.gear}` : '미장착'}으로 계산합니다. 설정은 보관됩니다.`);
  if (build.potential && !b.potential) notes.push('잠재력은 5성·Lv.90 조건이 충족되지 않아 계산에서 제외합니다. 설정은 보관됩니다.');
  const multipliers = { AttackPower: student.Transcendence?.[0] ?? [0, 1000, 1200, 1400, 1700],
    MaxHP: student.Transcendence?.[1] ?? [0, 500, 700, 900, 1400],
    HealPower: student.Transcendence?.[2] ?? [0, 750, 1000, 1200, 1500] };
  const base = { AccuracyPoint: student.AccuracyPoint ?? 0, DodgePoint: student.DodgePoint ?? 0,
    CriticalPoint: student.CriticalPoint ?? 0, CriticalDamageRate: student.CriticalDamageRate ?? 20000,
    StabilityPoint: student.StabilityPoint ?? 0, StabilityRate: student.StabilityRate ?? 2000,
    DefensePenetration: 0, CriticalChanceRate: 0, CriticalChanceResistPoint: student.CriticalChanceResistPoint ?? 100,
    CriticalDamageResistRate: student.CriticalDamageResistRate ?? 5000, HealEffectivenessRate: 10000,
    EnhanceExDamageRate: 10000, EnhanceBasicsDamageRate: 10000,
    EnhanceExplosionRate: 10000, EnhancePierceRate: 10000, EnhanceMysticRate: 10000, EnhanceSonicRate: 10000,
    DamageRatio: 10000, DamageRatio2: 10000, RegenCost: student.RegenCost ?? 700, ExtendBuffDuration: 10000, AttackSpeed: student.AttackSpeed ?? 10000 };
  for (const stat of ['MaxHP', 'AttackPower', 'DefensePower', 'HealPower', 'DefensePenetration']) {
    if (student[`${stat}1`] !== undefined) {
      const multiplier = 1 + (multipliers[stat]?.slice(0, b.stars).reduce((a, n) => a + n, 0) ?? 0) / 10000;
      base[stat] = interpolate(student[`${stat}1`], student[`${stat}100`], b.level, multiplier);
    }
  }
  const additions = {};
  const add = (key, amount) => {
    const [stat, kind] = key.split('_');
    if (!(stat in base)) return;
    additions[stat] ??= { Base: 0, Coefficient: 0, BaseOuter: 0 };
    if (kind in additions[stat]) additions[stat][kind] += amount;
  };
  if (b.weaponStars && student.Weapon) {
    for (const stat of ['MaxHP', 'AttackPower', 'HealPower']) add(`${stat}_Base`, interpolate(student.Weapon[`${stat}1`] ?? 0, student.Weapon[`${stat}100`] ?? 0, b.weaponLevel));
  }
  for (let i = 1; i < b.bond; i++) {
    const band = i < 20 ? Math.floor(i / 5) : 2 + Math.floor(i / 10);
    student.FavorStatType?.forEach((stat, index) => add(`${stat}_Base`, student.FavorStatValue[band]?.[index] ?? 0));
  }
  for (const [slot, tier] of b.equipment.entries()) {
    if (!tier) continue;
    const equipment = data.equipment.find(e => e.Category === student.Equipment[slot] && e.Tier === tier);
    if (!equipment) { notes.push(`장비 ${slot + 1}의 T${tier} 데이터가 없습니다.`); continue; }
    equipment.StatType.forEach((type, i) => add(type, equipment.StatValue[i][1]));
  }
  if (b.gear) student.Gear.StatType.forEach((type, i) => add(type, student.Gear.StatValue[i][1]));
  if (b.potential) for (const stat of ['MaxHP', 'AttackPower', 'HealPower']) add(`${stat}_Base`, Math.round(interpolate(student[`${stat}1`], student[`${stat}100`], b.level) * b.potential * 0.002));
  if (b.passive) {
    const skills = [student.Skills.Passive, b.weaponStars >= 2 ? student.Skills.WeaponPassive : null].filter(Boolean);
    for (const skill of skills) {
      for (const e of skill.Effects ?? []) {
        if (e.Type === 'Buff' && !e.Condition && Array.isArray(e.Target) && e.Target.includes('Self') && e.Stat && e.Value?.length === 1 && !e.Duration && !e.Stack) {
          add(e.Stat, atLevel(e.Value[0], b.skills.Passive));
        } else notes.push('조건부·특수 강화 스킬 효과는 능력치에 자동 적용하지 않습니다.');
      }
    }
  }
  add('AttackPower_Coefficient', clamp(attackBuff, -80, 1000) * 100);
  add('CriticalDamageRate_Coefficient', clamp(critBuff, -80, 1000) * 100);
  for (const bonus of bonuses) add(bonus.stat, bonus.amount);
  for (const stat in base) {
    const a = additions[stat] ?? { Base: 0, Coefficient: 0, BaseOuter: 0 };
    const limit = data.limits[stat];
    const rate = limit ? clamp(1 + a.Coefficient / 10000, 1 + limit.RatioMin / 10000, 1 + limit.RatioMax / 10000) : 1 + a.Coefficient / 10000;
    const total = Math.round(Number(((base[stat] + a.Base) * rate).toFixed(4))) + a.BaseOuter;
    stats[stat] = limit ? clamp(total, limit.Min, limit.Max) : Math.max(0, total);
  }
  return { build: b, stats, base, additions, notes: [...new Set(notes)] };
}

// Reuse a member's growth/equipment calculation for the whole timeline.
export function applyStudentBonuses(calculated, bonuses, data, attackBuff = 0, critBuff = 0) {
  const own = Object.entries(calculated.additions).flatMap(([stat, kinds]) => Object.entries(kinds).map(([kind, amount]) => ({ stat: `${stat}_${kind}`, amount })));
  const all = [...own, ...bonuses, { stat: 'AttackPower_Coefficient', amount: clamp(attackBuff, -80, 1000) * 100 },
    { stat: 'CriticalDamageRate_Coefficient', amount: clamp(critBuff, -80, 1000) * 100 }];
  return { ...calculated, stats: Object.fromEntries(Object.entries(calculated.base).map(([stat, base]) => [stat, modifiedStat(base, stat, all, data.limits)])) };
}

// Uniform stability roll, integrated across the damage soft-cap's linear pieces.
// Integer rounding is omitted only in these distribution moments.
export function damageMoments(low, high, newLimit = true) {
  const bounds = newLimit ? [1, 4000000, 6248000, 8496000, 10744000, 12992000, 15240000, 17488000, 19736000, 22000000] : [1, 4000000];
  const slopes = newLimit ? [0, 1, .8, .65, .5, .4, .3, .225, .15, .075, 0] : [0, 1, 0];
  const continuous = x => {
    let y = 1;
    for (let i = 0; i < bounds.length - 1; i++) y += Math.max(0, Math.min(x, bounds[i + 1]) - bounds[i]) * slopes[i + 1];
    return y;
  };
  if (high <= low) { const mean = continuous(low); return { mean, second: mean * mean }; }
  const points = [low, ...bounds.filter(x => x > low && x < high), high];
  let mean = 0, second = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], ya = continuous(a), yb = continuous(b), weight = (b - a) / (high - low);
    mean += weight * (ya + yb) / 2;
    second += weight * (ya * ya + ya * yb + yb * yb) / 3;
  }
  return { mean, second };
}

export function skillDescription(skill, level, labels) {
  return (skill?.Desc ?? '일반 공격으로 적을 공격합니다.')
    .replace(/<\?(\d+)>/g, (_, n) => String(atLevel(skill.Parameters?.[Number(n) - 1] ?? [], level)))
    .replace(/<[bd]:([^>]+)>/g, (_, raw) => {
      const named=raw.match(/^([^=]+)=['"]([^'"]+)['"]$/),key=named?.[1]??raw;
      return named?.[2] ?? labels.BuffName[`Buff_${key}`] ?? labels.BuffName[`Debuff_${key}`] ?? key;
    })
    .replace(/<[^>]*>/g, '').replace(/\/\n/g, '\n');
}

export function skillOptions(student, build) {
  const skills = student.Skills;
  const result = [];
  for (const type of ['Ex', 'Public', 'Passive', 'ExtraPassive', 'Normal']) {
    const activeType = type === 'Public' && build.gear >= 2 && skills.GearPublic ? 'GearPublic' : type;
    const main = skills[activeType];
    if (!main) continue;
    result.push({ key: type, type: activeType, skill: main });
    for (const [i, skill] of (main.ExtraSkills ?? []).entries()) result.push({ key: `${type}:${i}`, type: activeType, skill, parent: type });
  }
  return result;
}

export function unsupportedDamage(effect, skill) {
  const reasons = [];
  const korean = { TargetHpRateModifier: '적 HP 의존', StatModifier: '능력치 조건', MultiplySource: 'HP 등에 따른 추가 배율',
    SubstituteScale: '조건별 배율', ZoneHitInterval: '지속 범위 공격', Critical: '특수 치명타 처리',
    Frames: '일반 공격 변경' };
  for (const key of Object.keys(korean)) if (effect[key] !== undefined) reasons.push(korean[key]);
  if (skill.FormChange) reasons.push('일반 공격 변경');
  if (effect.SourceStat && !['AttackPower', 'MaxHP', 'DefensePower', 'HealPower'].includes(effect.SourceStat)) reasons.push('특수 기준 능력치');
  return reasons;
}

// New global per-hit damage soft cap, as of the data build.
export function damageCap(damage) {
  const segments = [[1, 4000000], [0.8, 6248000], [0.65, 8496000], [0.5, 10744000], [0.4, 12992000],
    [0.3, 15240000], [0.225, 17488000], [0.15, 19736000], [0.075, 22000000]];
  let total = clamp(damage, 1, 4000000);
  for (let i = 1; i < segments.length && damage >= segments[i - 1][1]; i++) total += Math.round(segments[i][0] * (Math.min(damage, segments[i][1]) - segments[i - 1][1]));
  return Math.min(total, 10969999);
}

export function combatResult(student, build, data, skill, effect, level, enemy) {
  if (!effect || effect.Type !== 'Damage') return { supported: false, reasons: ['직접 피해 효과를 선택하세요.'] };
  const reasons = unsupportedDamage(effect, skill);
  if (effect.Condition && !enemy.assumeCondition) reasons.push('효과 조건이 충족됐는지 확인이 필요합니다.');
  if (reasons.length) return { supported: false, reasons };
  const calculated = enemy.calculatedStudent ?? studentStats(student, build, data, enemy.attackBuff, enemy.critBuff, enemy.studentBonuses ?? []);
  const stats = calculated.stats;
  const terrain = enemy.terrain || 'Street';
  let affinity = student[`${terrain}BattleAdaptation`] ?? 2;
  if (calculated.build.weaponStars >= 3 && student.Weapon?.AdaptationType === terrain) affinity += student.Weapon.AdaptationValue;
  const terrainMod = 0.8 + affinity * 0.1;
  let effectiveness = (data.effectiveness[student.BulletType]?.[enemy.armor] ?? 10000) / 10000;
  if (effectiveness === 2) effectiveness += clamp(enemy.effectiveBuff, 0, 1000) / 100 + ((stats[`Enhance${student.BulletType}Rate`] ?? 10000) - 10000) / 10000 + (calculated.build.weaponStars >= 4 && student.SquadType === 'Main' ? 0.1 : 0);
  const enemyBonuses = enemy.enemyBonuses ?? [];
  const enemyLimits = enemy.limits ?? data.limits;
  const enemyStat = (name, value) => modifiedStat(value, name, enemyBonuses, enemyLimits);
  const defense = enemyBonuses.some(b => b.stat.startsWith('DefensePower_'))
    ? modifiedStat(clamp(enemy.defense, 0, 1000000), 'DefensePower', [...enemyBonuses,
      { stat: 'DefensePower_Coefficient', amount: -clamp(enemy.defDown, 0, 80) * 100 }], enemyLimits)
    : clamp(enemy.defense, 0, 1000000) * Math.max(0.2, 1 - clamp(enemy.defDown, 0, 80) / 100);
  const ignored = atLevel(effect.IgnoreDef, level) || (effect.IgnoreDef ? 0 : 10000);
  const penetration = stats.DefensePenetration + clamp(enemy.penetration, 0, 1000000);
  const defenseMod = 10000000 / (Math.max((defense - penetration) * ignored / 10000, 0) * 6000 + 10000000);
  const levelMod = clamp(1 - (clamp(enemy.level, 1, 100) - calculated.build.level) * 0.02, 0.4, 1);
  const stability = effect.ApplyStability === false ? 1 : clamp(stats.StabilityPoint / (stats.StabilityPoint + 1000) + stats.StabilityRate / 10000, 0, 1);
  const diff = Math.max(stats.CriticalPoint - enemyStat('CriticalChanceResistPoint', clamp(enemy.critResist, 0, 1000000)), 0);
  const critRate = effect.CriticalCheck === 'Always' ? 1 : effect.CriticalCheck === 'Never' ? 0 : clamp(1 - 2000 / (diff * 3 + 2000) + stats.CriticalChanceRate / 10000, 0, 1);
  const critMod = Math.max(1, (stats.CriticalDamageRate - enemyStat('CriticalDamageResistRate', clamp(enemy.critDmgResist, 0, 10000) * 100)) / 10000);
  const accuracy = effect.CanEvade === false ? 1 : clamp(2000 / (Math.max(enemyStat('DodgePoint', clamp(enemy.evasion, 0, 1000000)) - stats.AccuracyPoint, 0) * 3 + 2000), 0, 1);
  const scale = atLevel(effect.Scale, level);
  const source = stats[effect.SourceStat ?? 'AttackPower'];
  const damageType = effect.OverrideSkillDamageType ?? enemy.skillType;
  const exMod = damageType === 'Ex' ? (stats.EnhanceExDamageRate / 10000 + clamp(enemy.exBuff, 0, 400) / 100) * (20000 - enemyStat('ExDamagedRatio', enemy.ExDamagedRatio ?? 10000)) / 10000 : 1;
  const basicMod = ['Normal', 'Public', 'GearPublic', 'ExtraPassive'].includes(damageType) ? stats.EnhanceBasicsDamageRate / 10000 : 1;
  const baseEffectiveness = (data.effectiveness[student.BulletType]?.[enemy.armor] ?? 10000) / 10000;
  const attribute = baseEffectiveness >= 2 ? 'Weak' : baseEffectiveness === 1.5 ? 'Effective' : baseEffectiveness === 0.5 ? 'Resist' : 'Normal';
  const received = enemyStat(`${attribute}DamagedRatio`, enemy[`${attribute}DamagedRatio`] ?? 10000) / 10000;
  const weakness = baseEffectiveness >= 2 ? (20000 - enemyStat('ReduceWeakDamagedRate', enemy.ReduceWeakDamagedRate ?? 10000)) / 10000 : 1;
  const damageMod = Math.max(0, 10000 + stats.DamageRatio - enemyStat('DamagedRatio', enemy.DamagedRatio ?? 10000)) / 10000 *
    Math.max(0, 10000 + stats.DamageRatio2 - enemyStat('DamagedRatio2', enemy.DamagedRatio2 ?? 10000)) / 10000 *
    (1 + clamp(enemy.damageBuff, 0, 900) / 100) * basicMod * received * weakness;
  const hits = effect.Hits?.length ? effect.Hits : [10000];
  const cap = data.meta.region.UseNewCalculationLimit ? damageCap : d => clamp(d, 1, 4000000);
  const result = { supported: true, nonCrit: { min: 0, max: 0, avg: 0 }, crit: { min: 0, max: 0, avg: 0 }, expected: 0,
    critRate, critMod, accuracy, terrainMod, affinity, effectiveness, defenseMod, levelMod, stability,
    scale: scale * hits.reduce((a, b) => a + b, 0) / 10000, hitCount: hits.length, stats, defense, notes: calculated.notes,
    mean: 0, variance: 0, ceiling: 0 };
  for (const hit of hits) {
    const raw = source * scale / 10000 * hit / 10000 * terrainMod * effectiveness * defenseMod * levelMod * exMod * damageMod;
    const plain = damageMoments(raw * stability, raw, data.meta.region.UseNewCalculationLimit);
    const critical = damageMoments(raw * critMod * stability, raw * critMod, data.meta.region.UseNewCalculationLimit);
    const mean = accuracy * ((1 - critRate) * plain.mean + critRate * critical.mean);
    const second = accuracy * ((1 - critRate) * plain.second + critRate * critical.second);
    result.mean += mean;
    result.variance += Math.max(0, second - mean * mean);
    result.ceiling += cap(Math.round(raw * (critRate > 0 ? critMod : 1)));
    for (const [key, multiplier] of [['nonCrit', 1], ['crit', critMod]]) {
      result[key].min += cap(Math.round(raw * multiplier * stability));
      result[key].max += cap(Math.round(raw * multiplier));
      result[key].avg += cap(Math.round(raw * multiplier * (1 + stability) / 2));
    }
  }
  const pulses = effect.HitFrames?.length || 1;
  if(pulses>1){
    for(const part of [result.nonCrit,result.crit])for(const key of ['min','max','avg'])part[key]*=pulses;
    for(const key of ['mean','variance','ceiling','scale','hitCount'])result[key]*=pulses;
  }
  result.expected = (result.nonCrit.avg * (1 - critRate) + result.crit.avg * critRate) * accuracy;
  return result;
}
